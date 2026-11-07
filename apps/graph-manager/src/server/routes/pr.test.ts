import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { Config } from "../config.js";
import type { DataStore } from "../store.js";
import { pushProgress } from "../pr.js";
import { appWithLogin } from "../test-helpers.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let config: Config;
let store: DataStore;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  forge = await startFakeForge();
  ({ app, cookie, config, store, cleanup } = await appWithLogin({ githubApiUrl: `${forge.url}/github` }));
});

afterEach(async () => {
  await cleanup();
  await forge.close();
});

const req = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });

async function connect(kind: "github" | "gitlab"): Promise<void> {
  const body = kind === "github" ? { token: "gh-good" } : { token: "gl-good", baseUrl: `${forge.url}/gitlab` };
  expect((await req("PUT", `/api/forges/${kind}`, body)).statusCode).toBe(200);
}

/** Clones the repo and writes `.graph-execution/<runId>/state.json` plus a spec; returns the checkout path. */
async function cloneWithRun(kind: "github" | "gitlab", fullPath: string, runId: string, status: string): Promise<string> {
  const res = await req("POST", "/api/workspaces", { forge: kind, fullPath });
  expect(res.statusCode).toBe(202);
  const id = (res.json() as { job: { id: string } }).job.id;
  for (let i = 0; ; i++) {
    const jobs = (await req("GET", "/api/workspaces/clones")).json() as { jobs: { id: string; status: string; error?: string }[] };
    const job = jobs.jobs.find((j) => j.id === id);
    if (job?.status === "done") break;
    if (job?.status !== "running" || i > 500) throw new Error(`clone of ${fullPath} did not finish: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const dest = path.join(config.workspacesDir, kind, ...fullPath.split("/"));
  await writeRun(dest, runId, status);
  return dest;
}

async function writeRun(dest: string, runId: string, status: string): Promise<void> {
  const runDir = path.join(dest, ".graph-execution", runId);
  const tasksDir = path.join(runDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, "1.json"), JSON.stringify({ id: "1", content: "# Say hello\n\nWrite hello.txt.", dependencies: [] }));
  const specPath = path.join(runDir, "spec.md");
  await writeFile(specPath, "Intro\n\n# Hello feature\n\nBody.\n");
  const state = stateSchema.parse({
    runId,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${runId}`,
    specPath,
    tasksDir,
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "merged", attempts: 1 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-06T10:00:00.000Z",
    status,
  });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
}

interface Job {
  id: string;
  status: "running" | "done" | "failed";
  steps: { name: string; state: string; detail?: string; progress?: number }[];
  error?: string;
  failedStep?: string;
  pr?: { url: string; number: number; branch: string };
  base: string;
  branch: string;
  startedAt: string;
}

interface Status {
  pr?: { url: string; number: number; branch: string; base?: string };
  eligible: boolean;
  reason?: string;
  suggested?: { branch: string; title: string; body: string; base: string; bases: string[] };
  job?: Job;
}

const status = async (ws: string, runId: string): Promise<Status> => (await req("GET", `/api/runs/${ws}/${runId}/pr`)).json() as Status;

/** Polls GET …/pr until the run's job is no longer running; returns the last status (with the job). */
async function waitForJob(ws: string, runId: string): Promise<Status & { job: Job }> {
  for (let i = 0; ; i++) {
    const s = await status(ws, runId);
    if (!s.job) throw new Error("no job");
    if (s.job.status !== "running") return s as Status & { job: Job };
    if (i > 1000) throw new Error(`job still running: ${JSON.stringify(s.job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** POSTs Create PR, expects 202 and waits for the job to end. */
async function createPr(ws: string, runId: string, payload: object): Promise<Status & { job: Job }> {
  const res = await req("POST", `/api/runs/${ws}/${runId}/pr`, payload);
  expect(res.statusCode).toBe(202);
  const { job } = res.json() as { job: Job };
  expect(job).toMatchObject({ status: "running", steps: [{ name: "checkout" }, { name: "commit" }, { name: "push" }, { name: "create" }] });
  const done = await waitForJob(ws, runId);
  expect(done.job.id).toBe(job.id);
  return done;
}

const bareOf = (fullPath: string): string => path.join(forge.dir, `${fullPath}.git`);

describe("pull request routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/runs/github~octo~hello/r1/pr" })).statusCode).toBe(401);
  });

  it("open a GitHub pull request for an applied run", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "applied");
    const ws = "github~octo~hello";

    let s = await status(ws, "r1");
    expect(s.eligible).toBe(false);
    expect(s.reason).toMatch(/no uncommitted changes/);

    writeFileSync(path.join(dest, "hello.txt"), "hello\n");
    s = await status(ws, "r1");
    expect(s.eligible).toBe(true);
    expect(s.suggested).toMatchObject({ branch: "gm/r1", title: "Hello feature", base: "main" });
    expect(s.suggested?.body).toContain("- [x] 1 Say hello");
    expect(s.suggested?.body).toContain("Generated by graph-execution run r1.");

    expect((await req("POST", `/api/runs/${ws}/r1/pr`, { branch: "bad..name", title: "t", body: "" })).statusCode).toBe(400);
    expect((await req("POST", `/api/runs/${ws}/r1/pr`, { branch: "@{-1}", title: "t", body: "" })).statusCode).toBe(400);

    expect(s.suggested?.bases).toEqual(["main"]);

    const done = await createPr(ws, "r1", { branch: "gm/r1", title: s.suggested!.title, body: s.suggested!.body });
    const job = done.job;
    expect(job.status).toBe("done");
    expect(job.steps.map((st) => [st.name, st.state])).toEqual([
      ["checkout", "done"],
      ["commit", "done"],
      ["push", "done"],
      ["create", "done"],
    ]);
    expect(job.steps.map((st) => st.detail)).toEqual(["gm/r1", "1 file · “Hello feature”", "origin", "GitHub PR → main"]);
    const pr = job.pr!;
    expect(pr).toMatchObject({ number: 1, branch: "gm/r1" });
    expect(pr.url).toMatch(/^http/);
    expect(JSON.stringify(done)).not.toContain("gh-good");
    expect(forge.pulls).toEqual([expect.objectContaining({ forge: "github", fullPath: "octo/hello", head: "gm/r1", base: "main", title: "Hello feature" })]);

    const bare = bareOf("octo/hello");
    const files = await execa("git", ["-C", bare, "ls-tree", "-r", "--name-only", "refs/heads/gm/r1"]);
    expect(files.stdout.split("\n")).toContain("hello.txt");
    expect(files.stdout).not.toContain(".graph-execution");
    // F2: the workspace is back on the branch it was on; the commit stays on gm/r1.
    expect((await execa("git", ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"])).stdout).toBe("main");
    const extra = await execa("git", ["-C", dest, "config", "--get-regexp", "extraheader"], { reject: false });
    expect(extra.stdout).toBe("");
    expect(JSON.stringify(store.get().prs)).not.toContain("gh-good");

    const again = await req("POST", `/api/runs/${ws}/r1/pr`, { branch: "gm/r1-b", title: "t", body: "" });
    expect(again.statusCode).toBe(409);
    s = await status(ws, "r1");
    expect(s).toEqual({ pr: { ...pr, base: "main" }, eligible: false, job });
    expect(store.get().prs[`${ws}/r1`]).toMatchObject({ url: pr.url, number: 1, branch: "gm/r1", forge: "github" });
  });

  it("moves the run's spec to docs/prd/done/ in the PR commit", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "applied");
    const ws = "github~octo~hello";
    const g = (...args: string[]) => execa("git", ["-C", dest, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await mkdir(path.join(dest, "docs", "prd"), { recursive: true });
    await writeFile(path.join(dest, "docs/prd/hello.md"), "# Hello feature\n\nBody.\n");
    await g("add", "--", "docs/prd/hello.md");
    await g("commit", "-q", "-m", "spec");
    const statePath = path.join(dest, ".graph-execution", "r1", "state.json");
    const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    await writeFile(statePath, JSON.stringify({ ...state, specPath: path.join(dest, "docs/prd/hello.md") }));
    writeFileSync(path.join(dest, "hello.txt"), "hello\n");

    const s = await status(ws, "r1");
    expect(s.suggested?.title).toBe("Hello feature");
    const done = await createPr(ws, "r1", { branch: "gm/r1", title: s.suggested!.title, body: s.suggested!.body });
    expect(done.job.status).toBe("done");
    expect(done.job.steps.find((st) => st.name === "commit")?.detail).toMatch(/^\d+ files · “Hello feature” · spec → docs\/prd\/done\/hello\.md$/);
    const files = (await execa("git", ["-C", bareOf("octo/hello"), "ls-tree", "-r", "--name-only", "refs/heads/gm/r1"])).stdout.split("\n");
    expect(files).toContain("docs/prd/done/hello.md");
    expect(files).not.toContain("docs/prd/hello.md");
    expect(files).toContain("hello.txt");
    expect(forge.pulls).toEqual([expect.objectContaining({ title: "Hello feature" })]);
  });

  it("refuse runs that have not landed, an existing branch, and a disconnected forge", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r2", "failed");
    writeFileSync(path.join(dest, "hello.txt"), "hello\n");
    const ws = "github~octo~hello";
    const failed = await req("POST", `/api/runs/${ws}/r2/pr`, { branch: "gm/r2", title: "t", body: "" });
    expect(failed.statusCode).toBe(409);
    expect((failed.json() as { error: string }).error).toMatch(/has not landed/);
    expect((await status(ws, "r2")).reason).toBe("the run has not landed (status failed)");

    await writeRun(dest, "r3", "applied");
    await execa("git", ["-C", dest, "branch", "gm/r3"]);
    const exists = await req("POST", `/api/runs/${ws}/r3/pr`, { branch: "gm/r3", title: "t", body: "" });
    expect(exists.statusCode).toBe(409);
    expect((exists.json() as { error: string }).error).toMatch(/already exists/);

    await store.update((d) => {
      delete d.forges.github;
    });
    expect((await status(ws, "r3")).reason).toBe("GitHub is not connected");
    expect((await req("GET", `/api/runs/${ws}/nope/pr`)).statusCode).toBe(404);
  });

  it("answer 409 to a second POST while a job runs", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "applied");
    writeFileSync(path.join(dest, "hello.txt"), "hello\n");
    const ws = "github~octo~hello";
    const [a, b] = await Promise.all([
      req("POST", `/api/runs/${ws}/r1/pr`, { branch: "gm/r1", title: "t", body: "" }),
      req("POST", `/api/runs/${ws}/r1/pr`, { branch: "gm/r1-b", title: "t", body: "" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect((refused.json() as { error: string }).error).toBe("a pull request is already being created");
    expect((await waitForJob(ws, "r1")).job.status).toBe("done");
    expect(forge.pulls).toHaveLength(1);
  });

  it("fail the job at the push step, with the token scrubbed, when the remote is missing", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "applied");
    writeFileSync(path.join(dest, "hello.txt"), "hello\n");
    rmSync(bareOf("octo/hello"), { recursive: true, force: true });
    const done = await createPr("github~octo~hello", "r1", { branch: "gm/r1", title: "t", body: "b" });
    expect(done.job).toMatchObject({ status: "failed", failedStep: "push" });
    expect(done.job.steps.map((st) => st.state)).toEqual(["done", "done", "failed", "pending"]);
    expect(done.job.error).toMatch(/^push failed: /);
    expect(JSON.stringify(done)).not.toContain("gh-good");
    // The commit stays on the new branch; nothing is undone.
    const branch = await execa("git", ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout).toBe("gm/r1");
    expect(store.get().prs).toEqual({});
  });

  it("open a GitLab merge request", async () => {
    await connect("gitlab");
    const dest = await cloneWithRun("gitlab", "grp/sub/proj", "r1", "applied");
    writeFileSync(path.join(dest, "hello.txt"), "hello\n");
    // Not ignored this time: the run folder must still stay out of the commit.
    writeFileSync(path.join(dest, ".git", "info", "exclude"), "");
    const ws = "gitlab~grp~sub~proj";
    const s = await status(ws, "r1");
    expect(s.eligible).toBe(true);
    const done = await createPr(ws, "r1", { branch: s.suggested!.branch, title: s.suggested!.title, body: s.suggested!.body });
    expect(done.job).toMatchObject({ status: "done", pr: { number: 1, branch: "gm/r1" } });
    expect(done.job.steps[3]?.detail).toBe("GitLab MR → main");
    expect(JSON.stringify(done)).not.toContain("gl-good");
    expect(forge.pulls).toEqual([expect.objectContaining({ forge: "gitlab", fullPath: "grp/sub/proj", head: "gm/r1", base: "main" })]);
    expect(existsSync(bareOf("grp/sub/proj"))).toBe(true);
    const files = await execa("git", ["-C", bareOf("grp/sub/proj"), "ls-tree", "-r", "--name-only", "refs/heads/gm/r1"]);
    expect(files.stdout.split("\n")).toContain("hello.txt");
    expect(files.stdout).not.toContain(".graph-execution");
  });
});

describe("pushProgress", () => {
  it("reads the last Writing objects percentage of a chunk", () => {
    expect(pushProgress("Enumerating objects: 5, done.\rWriting objects:  12% (1/8)\rWriting objects:  62% (5/8)\r")).toBe(0.62);
    expect(pushProgress("Writing objects: 100% (8/8), 1.2 KiB | 1.2 MiB/s, done.\n")).toBe(1);
    expect(pushProgress("Counting objects: 50%")).toBeUndefined();
  });
});
