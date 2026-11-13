// Create PR for a project run (docs/prd/multi-repo.md, MR-09): one linked PR per changed repo.
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { suiteStateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { Config } from "../config.js";
import type { DataStore } from "../store.js";
import { appWithLogin } from "../test-helpers.js";

const HOME = "project~billing";
const SUITE = "suite-20261113-120000-abcd";
const BRANCH = `gm/${SUITE}`;

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let config: Config;
let store: DataStore;
let cleanup: () => Promise<void>;
let projDir: string;

const req = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const wsDirOf = (name: string) => path.join(config.workspacesDir, "github", "acme", name);
const bareOf = (fullPath: string): string => path.join(forge.dir, `${fullPath}.git`);

async function connect(): Promise<void> {
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
}

async function clone(fullPath: string): Promise<void> {
  forge.addRepo(fullPath, "github");
  const res = await req("POST", "/api/workspaces", { forge: "github", fullPath });
  expect(res.statusCode).toBe(202);
  const id = (res.json() as { job: { id: string } }).job.id;
  for (let i = 0; ; i++) {
    const jobs = (await req("GET", "/api/workspaces/clones")).json() as { jobs: { id: string; status: string }[] };
    const job = jobs.jobs.find((j) => j.id === id);
    if (job?.status === "done") break;
    if (job?.status !== "running" || i > 500) throw new Error(`clone of ${fullPath} did not finish: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function writeSuite(status: string): Promise<void> {
  const suiteDir = path.join(projDir, ".graph-execution", SUITE);
  const repo = (name: string) => ({ name, path: wsDirOf(name), startingCommit: "0".repeat(40), startBranch: "main" });
  const suite = suiteStateSchema.parse({
    suiteId: SUITE,
    status,
    provider: "fake",
    concurrency: 2,
    startingCommit: "0".repeat(40),
    startBranch: "main",
    merge: true,
    features: ["api", "web"].map((n, i) => ({
      name: n,
      tasksDir: path.join(projDir, "tasks", n),
      prd: path.join(suiteDir, "specs", `${n}.md`),
      runId: `20261113-12000${i}-aaaa`,
      status: "done",
      repo: repo(n),
    })),
    project: { dir: projDir, name: "billing", contract: path.join(projDir, "contract.md") },
    repos: [
      { ...repo("api"), applied: { files: 1, conflicts: [] } },
      { ...repo("web"), applied: { files: 1, conflicts: [] } },
    ],
    createdAt: "2026-11-13T12:00:00.000Z",
  });
  await mkdir(suiteDir, { recursive: true });
  await writeFile(path.join(suiteDir, "suite.json"), JSON.stringify(suite));
}

beforeEach(async () => {
  forge = await startFakeForge();
  ({ app, cookie, config, store, cleanup } = await appWithLogin({ githubApiUrl: `${forge.url}/github` }));
  await connect();
  await clone("acme/api");
  await clone("acme/web");
  projDir = path.join(config.workspacesDir, ".projects", "billing");
  await mkdir(path.join(projDir, "repos"), { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: projDir });
  for (const r of ["api", "web"]) await symlink(wsDirOf(r), path.join(projDir, "repos", r), process.platform === "win32" ? "junction" : "dir");
  await writeFile(
    path.join(projDir, "project.json"),
    JSON.stringify({ name: "billing", repos: [{ name: "api", path: "repos/api" }, { name: "web", path: "repos/web" }] }),
  );
  await writeFile(path.join(projDir, "contract.md"), "# Contract\n\nGET /invoices\n");
  await mkdir(path.join(projDir, "specs"), { recursive: true });
  await writeFile(path.join(projDir, "specs", "api.md"), "# Billing API\n\nBody.\n");
  await writeFile(path.join(projDir, "specs", "web.md"), "# Billing web\n\nBody.\n");
  await mkdir(path.join(projDir, "tasks", "api"), { recursive: true });
  await writeFile(path.join(projDir, "tasks", "api", "1.json"), JSON.stringify({ id: "1", content: "# Add endpoint", dependencies: [] }));
  await store.update((d) => {
    d.projects.billing = { name: "billing", workspaces: ["github~acme~api", "github~acme~web"], createdAt: "2026-11-13T00:00:00.000Z" };
  });
  await writeSuite("applied");
});

afterEach(async () => {
  await cleanup();
  await forge.close();
});

interface JobRepo {
  name: string;
  status: string;
  steps: { name: string; state: string; detail?: string }[];
  error?: string;
  pr?: { url: string; number: number; branch: string };
}
interface Job {
  id: string;
  status: "running" | "done" | "failed";
  repos: JobRepo[];
  link: { state: string; detail?: string };
  error?: string;
}
interface Status {
  project: true;
  eligible: boolean;
  reason?: string;
  repos: { name: string; fullPath?: string; changed: boolean; pr?: { url: string; number: number }; linked?: boolean; error?: string }[];
  job?: Job;
}

const status = async (): Promise<Status> => {
  const res = await req("GET", `/api/runs/${HOME}/${SUITE}/pr`);
  expect(res.statusCode).toBe(200);
  return res.json() as Status;
};

async function createPrs(): Promise<Status & { job: Job }> {
  const res = await req("POST", `/api/runs/${HOME}/${SUITE}/pr`);
  expect(res.statusCode).toBe(202);
  const { job } = res.json() as { job: Job };
  for (let i = 0; ; i++) {
    const s = await status();
    if (s.job && s.job.id === job.id && s.job.status !== "running") return s as Status & { job: Job };
    if (i > 1000) throw new Error(`job still running: ${JSON.stringify(s.job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const filesOf = async (fullPath: string): Promise<string[]> =>
  (await execa("git", ["-C", bareOf(fullPath), "ls-tree", "-r", "--name-only", `refs/heads/${BRANCH}`])).stdout.split("\n");
const headOf = async (name: string): Promise<string> => (await execa("git", ["-C", wsDirOf(name), "rev-parse", "--abbrev-ref", "HEAD"])).stdout;
const repoOf = (job: Job, name: string): JobRepo => job.repos.find((r) => r.name === name)!;

describe("Create PR for a project run", () => {
  it("opens one linked PR per changed repo", async () => {
    writeFileSync(path.join(wsDirOf("api"), "hello.txt"), "api\n");
    writeFileSync(path.join(wsDirOf("web"), "hello.txt"), "web\n");
    let s = await status();
    expect(s.eligible).toBe(true);
    expect(s.repos.map((r) => [r.name, r.fullPath, r.changed])).toEqual([
      ["api", "acme/api", true],
      ["web", "acme/web", true],
    ]);

    const done = await createPrs();
    expect(done.job, JSON.stringify(done.job)).toMatchObject({ status: "done" });
    expect(done.job.repos.map((r) => r.status)).toEqual(["done", "done"]);
    expect(done.job.link.state).toBe("done");
    expect(JSON.stringify(done)).not.toContain("gh-good");

    expect(forge.pulls).toHaveLength(2);
    expect(forge.pulls.every((p) => p.head === BRANCH && p.base === "main")).toBe(true);
    const api = forge.pulls.find((p) => p.fullPath === "acme/api")!;
    const web = forge.pulls.find((p) => p.fullPath === "acme/web")!;
    expect(api.title).toBe("Billing API");
    expect(web.title).toBe("Billing web");
    expect(api.body).toContain("- [x] 1 Add endpoint");
    expect(api.body).toContain(`Generated by graph-execution suite ${SUITE} (project billing).`);
    expect(api.body).toContain("## Related PRs");
    expect(api.body).toContain(`acme/web#${web.number}`);
    expect(web.body).toContain("## Related PRs");
    expect(web.body).toContain(`acme/api#${api.number}`);

    const apiFiles = await filesOf("acme/api");
    expect(apiFiles).toEqual(expect.arrayContaining(["hello.txt", "docs/prd/done/billing.md", "docs/prd/done/billing-contract.md"]));
    const webFiles = await filesOf("acme/web");
    expect(webFiles).toEqual(expect.arrayContaining(["hello.txt", "docs/prd/done/billing.md", "docs/prd/done/billing-contract.md"]));
    for (const f of [...apiFiles, ...webFiles]) expect(f).not.toContain(".graph-execution");

    expect(await headOf("api")).toBe("main");
    expect(await headOf("web")).toBe("main");
    const prs = store.get().prs;
    expect(prs[`billing/${SUITE}/api`]).toMatchObject({ number: api.number, branch: BRANCH, base: "main", forge: "github", linked: true });
    expect(prs[`billing/${SUITE}/web`]).toMatchObject({ number: web.number, linked: true });
    expect(JSON.stringify(prs)).not.toContain("gh-good");

    s = await status();
    expect(s).toMatchObject({ eligible: false, reason: "all pull requests are open" });
    expect((await req("POST", `/api/runs/${HOME}/${SUITE}/pr`)).statusCode).toBe(409);

    const runs = (await req("GET", "/api/runs")).json() as { runs: { id: string; pr?: { number: number } }[] };
    expect(runs.runs.find((r) => r.id === SUITE)?.pr).toMatchObject({ number: api.number });
  });

  it("opens a single PR when only one repo changed", async () => {
    writeFileSync(path.join(wsDirOf("api"), "hello.txt"), "api\n");
    const s = await status();
    expect(s.repos.map((r) => r.changed)).toEqual([true, false]);
    const done = await createPrs();
    expect(done.job.status).toBe("done");
    expect(done.job.repos.map((r) => r.status)).toEqual(["done", "skipped"]);
    expect(done.job.link.state).toBe("done");
    expect(forge.pulls).toHaveLength(1);
    expect(forge.pulls[0]?.body).not.toContain("## Related PRs");
    expect((await execa("git", ["-C", wsDirOf("web"), "branch", "--list", BRANCH])).stdout).toBe("");
    expect(store.get().prs[`billing/${SUITE}/web`]).toBeUndefined();
    expect((await status()).reason).toBe("all pull requests are open");
  });

  it("retries only the missing PR after a failure, then links both", async () => {
    writeFileSync(path.join(wsDirOf("api"), "hello.txt"), "api\n");
    writeFileSync(path.join(wsDirOf("web"), "hello.txt"), "web\n");
    rmSync(bareOf("acme/web"), { recursive: true, force: true });

    const first = await createPrs();
    expect(first.job.status).toBe("failed");
    expect(repoOf(first.job, "api").status).toBe("done");
    const web = repoOf(first.job, "web");
    expect(web.status).toBe("failed");
    expect(web.error).toMatch(/^push failed: /);
    expect(first.job.error).toMatch(/web: push failed: /);
    expect(first.job.link.state).not.toBe("done");
    expect(JSON.stringify(first)).not.toContain("gh-good");
    expect(await headOf("web")).toBe("main");
    expect((await execa("git", ["-C", wsDirOf("web"), "branch", "--list", BRANCH])).stdout).toContain(BRANCH);
    expect(forge.pulls).toHaveLength(1);
    expect(forge.pulls[0]?.body).toContain("- acme/web (opened with this one)");

    const s = await status();
    expect(s.eligible).toBe(true);
    expect(s.repos.find((r) => r.name === "web")).toMatchObject({ changed: true, error: expect.stringMatching(/^push failed/) });
    expect(s.repos.find((r) => r.name === "api")?.pr).toBeDefined();

    forge.addRepo("acme/web", "github");
    const second = await createPrs();
    expect(second.job.status).toBe("done");
    expect(repoOf(second.job, "api").status).toBe("skipped");
    expect(repoOf(second.job, "web").status).toBe("done");
    expect(repoOf(second.job, "web").steps.find((st) => st.name === "commit")?.detail).toBe("already committed");
    expect(second.job.link.state).toBe("done");
    expect(forge.pulls).toHaveLength(2);
    const apiPr = forge.pulls.find((p) => p.fullPath === "acme/api")!;
    const webPr = forge.pulls.find((p) => p.fullPath === "acme/web")!;
    expect(apiPr.body).toContain(`acme/web#${webPr.number}`);
    expect(webPr.body).toContain(`acme/api#${apiPr.number}`);
    expect(await filesOf("acme/web")).toEqual(expect.arrayContaining(["hello.txt", "docs/prd/done/billing-contract.md"]));
    expect(store.get().prs[`billing/${SUITE}/api`]?.linked).toBe(true);
    expect(store.get().prs[`billing/${SUITE}/web`]?.linked).toBe(true);
  });

  it("refuses a run that has not landed and a disconnected forge", async () => {
    writeFileSync(path.join(wsDirOf("api"), "hello.txt"), "api\n");
    await writeSuite("failed");
    const res = await req("POST", `/api/runs/${HOME}/${SUITE}/pr`);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("the run has not landed (status failed)");

    await writeSuite("applied");
    await store.update((d) => {
      delete d.forges.github;
    });
    expect((await status()).reason).toBe("GitHub is not connected");
    expect((await req("GET", `/api/runs/${HOME}/suite-20261113-120000-zzzz/pr`)).statusCode).toBe(404);
  });

  it("says when no repo has changes", async () => {
    expect(await status()).toMatchObject({ eligible: false, reason: "no repo has changes to open a PR from" });
  });
});
