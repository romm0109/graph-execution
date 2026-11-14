// Runs of a project (docs/prd/multi-repo.md, MR-08): `project~<id>` in the runs API, the proxy, start and resume.
// The project folder and its suite are written by hand; the engine is a fake bin that records how it was called.
import { realpathSync } from "node:fs";
import http from "node:http";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execa } from "execa";
import { suiteStateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeAsWorkspace, projectRepos, resolveRunHome } from "./runhome.js";
import { appWithLogin, tempDir } from "./test-helpers.js";

const HOME = "project~billing";
const SUITE = "suite-20261113-120000-abcd";
const FAKE_BIN = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./call.json", import.meta.url), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), reviewers: process.env.GRAPH_EXECUTION_REVIEWERS ?? null }));
console.log("Started suite ${SUITE} in the background: http://127.0.0.1:1/");
`;

type Ctx = Awaited<ReturnType<typeof appWithLogin>>;
let ctx: Ctx;
let cleanups: (() => Promise<void>)[];
let callFile: string;
let projDir: string;
let suiteDir: string;

const g = (cwd: string, ...a: string[]) => execa("git", a, { cwd });
const wsDirOf = (name: string) => path.join(ctx.config.workspacesDir, "github", "acme", name);

async function writeSuite(status: string): Promise<void> {
  const repo = (name: string) => ({ name, path: wsDirOf(name), startingCommit: "0".repeat(40), startBranch: "main" });
  const suite = suiteStateSchema.parse({
    suiteId: SUITE,
    status,
    provider: "fake",
    concurrency: 2,
    startingCommit: "0".repeat(40),
    startBranch: "main",
    merge: true,
    humanReview: false,
    features: ["api", "web"].map((n, i) => ({
      name: n,
      tasksDir: path.join(projDir, "tasks", n),
      prd: path.join(suiteDir, "specs", `${n}.md`),
      runId: `20261113-12000${i}-aaaa`,
      status: "done",
      repo: repo(n),
    })),
    integration: { merged: [] },
    project: { dir: projDir, name: "billing", contract: path.join(projDir, "contract.md") },
    repos: [
      { ...repo("api"), applied: { files: 1, conflicts: [] } },
      { ...repo("web"), applied: { files: 2, conflicts: [] } },
    ],
    createdAt: "2026-11-13T12:00:00.000Z",
  });
  await mkdir(suiteDir, { recursive: true });
  await writeFile(path.join(suiteDir, "suite.json"), JSON.stringify(suite));
}

beforeEach(async () => {
  const bin = await tempDir();
  const fake = path.join(bin.dir, "fake-ge.mjs");
  await writeFile(fake, FAKE_BIN);
  callFile = path.join(bin.dir, "call.json");
  ctx = await appWithLogin({ graphExecutionBin: fake });
  cleanups = [ctx.cleanup, bin.cleanup];
  for (const r of ["api", "web"]) {
    await mkdir(wsDirOf(r), { recursive: true });
    await g(wsDirOf(r), "init", "-q", "-b", "main");
  }
  // What createProjectFolder (projects.ts) makes, written by hand.
  projDir = path.join(ctx.config.workspacesDir, ".projects", "billing");
  await mkdir(path.join(projDir, "repos"), { recursive: true });
  await g(projDir, "init", "-q", "-b", "main");
  for (const r of ["api", "web"]) await symlink(wsDirOf(r), path.join(projDir, "repos", r), process.platform === "win32" ? "junction" : "dir");
  await writeFile(
    path.join(projDir, "project.json"),
    JSON.stringify({ name: "billing", repos: [{ name: "api", path: "repos/api" }, { name: "web", path: "repos/web" }] }),
  );
  await ctx.store.update((d) => {
    d.projects.billing = { name: "billing", workspaces: ["github~acme~api", "github~acme~web"], createdAt: "2026-11-13T00:00:00.000Z" };
  });
  suiteDir = path.join(projDir, ".graph-execution", SUITE);
  await writeSuite("applied");
});

afterEach(async () => {
  for (const c of cleanups) await c();
});

const get = (url: string) => ctx.app.inject({ method: "GET", url, headers: { cookie: ctx.cookie } });
const post = (url: string, payload?: Record<string, unknown>) => ctx.app.inject({ method: "POST", url, headers: { cookie: ctx.cookie }, ...(payload ? { payload } : {}) });

interface Call {
  argv: string[];
  cwd: string;
  reviewers: string | null;
}
const lastCall = async (): Promise<Call> => JSON.parse(await readFile(callFile, "utf8")) as Call;
const wasCalled = (): Promise<boolean> => readFile(callFile).then(() => true, () => false);

describe("resolveRunHome", () => {
  it("gives the project folder for project~<id>, and nothing for unknown or unsafe ids", () => {
    const root = ctx.config.workspacesDir;
    const home = resolveRunHome(root, ctx.store, HOME);
    expect(home).toMatchObject({ kind: "project", id: HOME, path: path.resolve(projDir), project: { id: "billing", name: "billing" } });
    expect(homeAsWorkspace(home!)).toEqual({ id: HOME, path: path.resolve(projDir), rel: ".projects/billing", forge: "project", fullPath: "billing" });
    for (const id of ["project~nope", "project~../x", "project~Billing", "project~", "project~billing~x", ".projects~billing"]) {
      expect(resolveRunHome(root, ctx.store, id), id).toBeUndefined();
    }
    expect(resolveRunHome(root, ctx.store, "github~acme~api")).toMatchObject({ kind: "workspace", id: "github~acme~api", path: wsDirOf("api") });
    expect(resolveRunHome(root, ctx.store, "github~acme~nope")).toBeUndefined();
  });

  it("does not resolve a stored project whose folder is gone", async () => {
    await ctx.store.update((d) => {
      d.projects.ghost = { name: "ghost", workspaces: ["github~acme~api", "github~acme~web"], createdAt: "2026-11-13T00:00:00.000Z" };
    });
    expect(resolveRunHome(ctx.config.workspacesDir, ctx.store, "project~ghost")).toBeUndefined();
  });

  it("matches the repos of project.json to their workspaces through the links", async () => {
    const home = resolveRunHome(ctx.config.workspacesDir, ctx.store, HOME);
    if (home?.kind !== "project") throw new Error("not a project home");
    const repos = await projectRepos(ctx.config.workspacesDir, home);
    expect(repos.map((r) => [r.name, r.path, r.workspace?.id])).toEqual([
      ["api", "repos/api", "github~acme~api"],
      ["web", "repos/web", "github~acme~web"],
    ]);
    // A link that is gone: the repo stays, without a workspace.
    await rm(path.join(projDir, "repos", "web"));
    expect((await projectRepos(ctx.config.workspacesDir, home)).map((r) => r.workspace?.id)).toEqual(["github~acme~api", undefined]);
  });
});

describe("runs of a project", () => {
  const summary = { workspaceId: HOME, type: "suite", id: SUITE, status: "applied", provider: "fake", live: false, project: { id: "billing", name: "billing", repos: ["api", "web"] } };

  it("lists the suite with its project, alone under the project filter", async () => {
    const all = (await get("/api/runs")).json() as { runs: Record<string, unknown>[] };
    expect(all.runs).toHaveLength(1);
    expect(all.runs[0]).toMatchObject(summary);
    expect(all.runs[0]).not.toHaveProperty("viewUrl");

    // A workspace run next to it: listed without `project`, and not under the project filter.
    const runDir = path.join(wsDirOf("api"), ".graph-execution", "gm-20261113-110000-aaaa");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "state.json"), "{}");
    const both = (await get("/api/runs")).json() as { runs: Record<string, unknown>[] };
    const wsRuns = both.runs.filter((r) => r.workspaceId === "github~acme~api");
    expect(wsRuns.length).toBeGreaterThan(0);
    for (const r of wsRuns) expect(r).not.toHaveProperty("project");

    const only = (await get(`/api/runs?workspace=${HOME}`)).json() as { runs: Record<string, unknown>[] };
    expect(only.runs).toHaveLength(1);
    expect(only.runs[0]).toMatchObject(summary);
    expect(((await get("/api/runs?workspace=project~nope")).json() as { runs: unknown[] }).runs).toEqual([]);
  });

  it("falls back to the repos of project.json when the suite names none", async () => {
    const raw = JSON.parse(await readFile(path.join(suiteDir, "suite.json"), "utf8")) as Record<string, unknown>;
    delete raw.repos;
    await writeFile(path.join(suiteDir, "suite.json"), JSON.stringify(raw));
    const res = (await get(`/api/runs?workspace=${HOME}`)).json() as { runs: { project?: unknown }[] };
    expect(res.runs[0]?.project).toEqual({ id: "billing", name: "billing", repos: ["api", "web"] });
  });

  it("gives the run's detail, and 404 for an unknown project", async () => {
    const res = await get(`/api/runs/${HOME}/${SUITE}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { summary: unknown }).summary).toMatchObject(summary);
    const unknown = await get(`/api/runs/project~nope/${SUITE}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "unknown workspace" });
    expect((await get(`/api/runs/${HOME}/suite-20261113-120000-ffff`)).statusCode).toBe(404);
  });

  it("proxies the page of a live project run", async () => {
    const upstream = http.createServer((req, res) => {
      const { port } = upstream.address() as AddressInfo;
      if (req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(421).end("bad host");
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>suite page</title>");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanups.unshift(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const { port } = upstream.address() as AddressInfo;
    await writeFile(path.join(suiteDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));

    const detail = (await get(`/api/runs/${HOME}/${SUITE}`)).json() as { summary: { live: boolean; viewUrl?: string } };
    expect(detail.summary).toMatchObject({ live: true, viewUrl: `/runs/project~billing/${SUITE}/view/` });

    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const page = await fetch(`${base}/runs/${HOME}/${SUITE}/view/`, { headers: { cookie: ctx.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("suite page");
    const unknown = await fetch(`${base}/runs/project~nope/${SUITE}/view/`, { headers: { cookie: ctx.cookie } });
    expect(unknown.status).toBe(404);
  });

  it("starts a project run with the suite command in the project folder", async () => {
    const res = await post(`/api/runs/${HOME}`, { provider: "fake", options: { humanReview: true }, tasksDir: "ignored", spec: "ignored.md" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ runId: SUITE, viewUrl: `/runs/project~billing/${SUITE}/view/` });
    const call = await lastCall();
    expect(call.argv).toEqual(["suite", "--project", ".", "--provider", "fake", "--human-review", "--web"]);
    expect(realpathSync.native(call.cwd)).toBe(realpathSync.native(projDir));
    expect(call.reviewers).toBe(path.join(ctx.config.dataDir, "reviewers.json"));

    const defaults = await get(`/api/workspaces/${HOME}/run-defaults`);
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toEqual({ provider: "fake", tasksDir: "", spec: "", options: { humanReview: true } });
    const settings = await get(`/api/workspaces/${HOME}/settings`);
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ sandbox: false });
    expect((await get("/api/workspaces/project~nope/run-defaults")).statusCode).toBe(404);
  });

  it("passes the suite's options and refuses the others, without starting anything", async () => {
    const ok = await post(`/api/runs/${HOME}`, { provider: "fake", options: { merge: false, model: "m1", concurrency: 3, extraArgs: "--no-color" } });
    expect(ok.statusCode).toBe(201);
    expect((await lastCall()).argv).toEqual(["suite", "--project", ".", "--provider", "fake", "--no-merge", "--model", "m1", "--concurrency", "3", "--no-color", "--web"]);
    await rm(callFile);

    const attempts = await post(`/api/runs/${HOME}`, { provider: "fake", options: { attempts: 2 } });
    expect(attempts.statusCode).toBe(400);
    expect(attempts.json()).toEqual({ error: "options.attempts does not apply to a project run" });
    for (const extraArgs of ["--project x", "--feature a=b"]) {
      const reserved = await post(`/api/runs/${HOME}`, { provider: "fake", options: { extraArgs } });
      expect(reserved.statusCode, extraArgs).toBe(400);
    }
    // No Docker here: a sandboxed start fails in the sandbox service (runs.sandbox.test.ts starts one), never on the server.
    const sandbox = await post(`/api/runs/${HOME}`, { provider: "fake", sandbox: true });
    expect(sandbox.statusCode).toBe(400);
    expect(sandbox.json<{ error: string }>().error).not.toMatch(/not supported/);
    expect((await post("/api/runs/project~nope", { provider: "fake" })).statusCode).toBe(404);
    expect(await wasCalled()).toBe(false);
  });

  it("inspects the project folder: each repo's spec and tasks, the contract and the test plan", async () => {
    await writeFile(path.join(projDir, "contract.md"), "# contract\n");
    await mkdir(path.join(projDir, "specs"), { recursive: true });
    await writeFile(path.join(projDir, "specs", "api.md"), "# api\n");
    await mkdir(path.join(projDir, "tasks", "api"), { recursive: true });
    await writeFile(path.join(projDir, "tasks", "api", "1.json"), "{}");
    await writeFile(path.join(projDir, "tasks", "api", "test-plan.json"), "{}");
    await writeFile(path.join(wsDirOf("web"), "new.txt"), "x");

    const res = await get("/api/projects/billing/inspect");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { repos: Record<string, unknown>[] };
    expect(body).toMatchObject({ id: "billing", name: "billing", contract: true, testPlan: false });
    expect(body.repos).toEqual([
      { name: "api", spec: true, taskFiles: 1, workspaceId: "github~acme~api", fullPath: "acme/api", branch: "main", changes: 0 },
      { name: "web", spec: false, workspaceId: "github~acme~web", fullPath: "acme/web", branch: "main", changes: 1 },
    ]);

    await writeFile(path.join(projDir, "test-plan.json"), "{}");
    expect(((await get("/api/projects/billing/inspect")).json() as { testPlan: boolean }).testPlan).toBe(true);
    const unknown = await get("/api/projects/nope/inspect");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "unknown project" });
  });

  it("resumes a project run that is not finished, in the project folder", async () => {
    const done = await post(`/api/runs/${HOME}/${SUITE}/resume`);
    expect(done.statusCode).toBe(409);
    expect(done.json()).toEqual({ error: "the run already finished (applied)" });
    expect(await wasCalled()).toBe(false);

    await writeSuite("failed");
    const res = await post(`/api/runs/${HOME}/${SUITE}/resume`);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ runId: SUITE, viewUrl: `/runs/project~billing/${SUITE}/view/` });
    const call = await lastCall();
    expect(call.argv).toEqual(["suite", "--resume", "--run", SUITE, "--web"]);
    expect(realpathSync.native(call.cwd)).toBe(realpathSync.native(projDir));

    expect((await post(`/api/runs/project~nope/${SUITE}/resume`)).statusCode).toBe(404);
  });

  it("still refuses to resume a suite of a workspace", async () => {
    const dir = path.join(wsDirOf("api"), ".graph-execution", SUITE);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "suite.json"), await readFile(path.join(suiteDir, "suite.json"), "utf8"));
    const res = await post(`/api/runs/github~acme~api/${SUITE}/resume`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "suites are resumed from a terminal" });
    expect(await wasCalled()).toBe(false);
  });
});
