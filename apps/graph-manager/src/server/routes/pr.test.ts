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
import { accessMessage, isAccessDenied, pushProgress } from "../pr.js";
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
  expect(job).toMatchObject({ status: "running", steps: [{ name: "access" }, { name: "commit" }, { name: "push" }, { name: "create" }] });
  const done = await waitForJob(ws, runId);
  expect(done.job.id).toBe(job.id);
  return done;
}

const bareOf = (fullPath: string): string => path.join(forge.dir, `${fullPath}.git`);

/** The run's result: `graph/<runId>` with a commit adding hello.txt, cut from main; the checkout stays on main. */
async function runBranch(dest: string, runId: string, file = "hello.txt"): Promise<void> {
  const g = (...args: string[]) => execa("git", ["-C", dest, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  const main = (await g("rev-parse", "HEAD")).stdout.trim();
  const statePath = path.join(dest, ".graph-execution", runId, "state.json");
  const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  await writeFile(statePath, JSON.stringify({ ...state, startingCommit: main }));
  await g("switch", "-q", "-c", `graph/${runId}`);
  writeFileSync(path.join(dest, file), "hello\n");
  await g("add", file);
  await g("commit", "-q", "-m", "run result");
  await g("switch", "-q", "main");
}

const headOf = async (dest: string) => ({
  branch: (await execa("git", ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"])).stdout,
  sha: (await execa("git", ["-C", dest, "rev-parse", "HEAD"])).stdout,
  status: (await execa("git", ["-C", dest, "status", "--porcelain"])).stdout,
});

describe("pull request routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/runs/github~octo~hello/r1/pr" })).statusCode).toBe(401);
  });

  it("open a GitHub pull request from the run's graph/<run-id> branch, never touching the checkout", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    const ws = "github~octo~hello";

    let s = await status(ws, "r1");
    expect(s.eligible).toBe(false);
    expect(s.reason).toBe("the run's branch graph/r1 is gone");

    await runBranch(dest, "r1");
    const before = await headOf(dest);
    s = await status(ws, "r1");
    expect(s.eligible).toBe(true);
    expect(s.suggested).toMatchObject({ branch: "graph/r1", title: "Hello feature", base: "main" });
    expect(s.suggested?.body).toContain("- [x] 1 Say hello");
    expect(s.suggested?.body).toContain("Generated by graph-execution run r1.");
    expect(s.suggested?.bases).toEqual(["main"]);

    const done = await createPr(ws, "r1", { title: s.suggested!.title, body: s.suggested!.body });
    const job = done.job;
    expect(job.status).toBe("done");
    expect(job.steps.map((st) => [st.name, st.state])).toEqual([
      ["access", "done"],
      ["commit", "done"],
      ["push", "done"],
      ["create", "done"],
    ]);
    expect(job.steps.map((st) => st.detail)).toEqual(["origin · octo/hello", "nothing to commit", "origin", "GitHub PR → main"]);
    const pr = job.pr!;
    expect(pr).toMatchObject({ number: 1, branch: "graph/r1" });
    expect(JSON.stringify(done)).not.toContain("gh-good");
    expect(forge.pulls).toEqual([expect.objectContaining({ forge: "github", fullPath: "octo/hello", head: "graph/r1", base: "main", title: "Hello feature" })]);

    const files = await execa("git", ["-C", bareOf("octo/hello"), "ls-tree", "-r", "--name-only", "refs/heads/graph/r1"]);
    expect(files.stdout.split("\n")).toContain("hello.txt");
    expect(files.stdout).not.toContain(".graph-execution");
    // The checkout did not move and got nothing (docs/prd/isolated-workspaces.md).
    expect(await headOf(dest)).toEqual(before);
    const extra = await execa("git", ["-C", dest, "config", "--get-regexp", "extraheader"], { reject: false });
    expect(extra.stdout).toBe("");
    expect(JSON.stringify(store.get().prs)).not.toContain("gh-good");

    const again = await req("POST", `/api/runs/${ws}/r1/pr`, { title: "t", body: "" });
    expect(again.statusCode).toBe(409);
    s = await status(ws, "r1");
    expect(s).toEqual({ pr: { ...pr, base: "main" }, eligible: false, job });
  });

  it("proposes the run's start branch as Merge into, and opens the PR into another branch when picked (KAN-103)", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    const ws = "github~octo~hello";
    await execa("git", ["-C", dest, "push", "-q", "origin", "main:refs/heads/develop"]);
    await execa("git", ["-C", dest, "fetch", "-q", "origin"]);
    await runBranch(dest, "r1");
    await store.update((d) => {
      d.runBases[`${ws}/r1`] = { base: "main" };
    });
    const s = await status(ws, "r1");
    expect(s.suggested?.base).toBe("main");
    expect(s.suggested?.bases).toEqual(["main", "develop"]);
    const done = await createPr(ws, "r1", { title: "t", body: "b", base: "develop" });
    expect(done.job.status).toBe("done");
    expect(forge.pulls).toEqual([expect.objectContaining({ head: "graph/r1", base: "develop" })]);
  });

  it("commits the spec's move to docs/prd/done/ on the run's branch once, in a throwaway worktree", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    const ws = "github~octo~hello";
    const g = (...args: string[]) => execa("git", ["-C", dest, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await mkdir(path.join(dest, "docs", "prd"), { recursive: true });
    await writeFile(path.join(dest, "docs/prd/hello.md"), "# Hello feature\n\nBody.\n");
    await g("add", "--", "docs/prd/hello.md");
    await g("commit", "-q", "-m", "spec");
    const statePath = path.join(dest, ".graph-execution", "r1", "state.json");
    const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    await writeFile(statePath, JSON.stringify({ ...state, specPath: path.join(dest, "docs/prd/hello.md") }));
    await runBranch(dest, "r1");
    const before = await headOf(dest);

    const s = await status(ws, "r1");
    expect(s.suggested?.title).toBe("Hello feature");
    const done = await createPr(ws, "r1", { title: s.suggested!.title, body: s.suggested!.body });
    expect(done.job.status).toBe("done");
    expect(done.job.steps.find((st) => st.name === "commit")?.detail).toBe("spec → docs/prd/done/hello.md");
    const files = (await execa("git", ["-C", bareOf("octo/hello"), "ls-tree", "-r", "--name-only", "refs/heads/graph/r1"])).stdout.split("\n");
    expect(files).toContain("docs/prd/done/hello.md");
    expect(files).not.toContain("docs/prd/hello.md");
    expect(files).toContain("hello.txt");
    // The checkout keeps its spec where it was; the throwaway worktree is gone.
    expect(await headOf(dest)).toEqual(before);
    expect(existsSync(path.join(dest, "docs/prd/hello.md"))).toBe(true);
    expect((await g("worktree", "list")).stdout.split("\n")).toHaveLength(1);
  });

  it("fails at the access step when the token can't push, changes nothing, and Retry finishes after the fix (push bug)", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    const ws = "github~octo~hello";
    const g = (...args: string[]) => execa("git", ["-C", dest, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await mkdir(path.join(dest, "docs", "prd"), { recursive: true });
    await writeFile(path.join(dest, "docs/prd/hello.md"), "# Hello feature\n");
    await g("add", "--", "docs/prd/hello.md");
    await g("commit", "-q", "-m", "spec");
    const statePath = path.join(dest, ".graph-execution", "r1", "state.json");
    const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    await writeFile(statePath, JSON.stringify({ ...state, specPath: path.join(dest, "docs/prd/hello.md") }));
    await runBranch(dest, "r1");
    const before = await headOf(dest);
    const branchBefore = (await g("rev-parse", "graph/r1")).stdout;
    // Pushes fail like a forge refusing the token.
    await g("config", "remote.origin.pushurl", path.join(forge.dir, "nowhere.git"));

    const failed = await createPr(ws, "r1", { title: "Hello feature", body: "b" });
    expect(failed.job).toMatchObject({ status: "failed", failedStep: "access" });
    expect(failed.job.steps.map((st) => st.state)).toEqual(["failed", "pending", "pending", "pending"]);
    expect(failed.job.error).toMatch(/^access failed: /);
    expect(JSON.stringify(failed)).not.toContain("gh-good");
    // Nothing changed: same checkout, same branch, and the run can still get its PR.
    expect(await headOf(dest)).toEqual(before);
    expect((await g("rev-parse", "graph/r1")).stdout).toBe(branchBefore);
    expect((await status(ws, "r1")).eligible).toBe(true);
    expect(store.get().prs).toEqual({});

    // A retry with nothing else: the failed job's title, body and base.
    expect((await req("POST", `/api/runs/${ws}/r1/pr`, { retry: true })).statusCode).toBe(202);
    const again = await waitForJob(ws, "r1");
    expect(again.job.failedStep).toBe("access");
    await g("config", "--unset", "remote.origin.pushurl");
    expect((await req("POST", `/api/runs/${ws}/r1/pr`, { retry: true })).statusCode).toBe(202);
    const ok = await waitForJob(ws, "r1");
    expect(ok.job.status).toBe("done");
    expect(forge.pulls).toEqual([expect.objectContaining({ head: "graph/r1", base: "main", title: "Hello feature", body: "b" })]);
    // One spec-move commit, however many attempts.
    const log = (await g("log", "--format=%s", `${branchBefore}..graph/r1`)).stdout.split("\n");
    expect(log).toEqual(["Move the spec to docs/prd/done/hello.md"]);
    expect(await headOf(dest)).toEqual(before);
  });

  it("refuses a retry without a failed job", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    await runBranch(dest, "r1");
    const res = await req("POST", "/api/runs/github~octo~hello/r1/pr", { retry: true });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("no failed Create PR to retry");
  });

  it("refuse runs that have not landed, a run that changed nothing, and a disconnected forge", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r2", "failed");
    const ws = "github~octo~hello";
    const failed = await req("POST", `/api/runs/${ws}/r2/pr`, { title: "t", body: "" });
    expect(failed.statusCode).toBe(409);
    expect((failed.json() as { error: string }).error).toMatch(/has not landed/);
    expect((await status(ws, "r2")).reason).toBe("the run has not landed (status failed)");

    await writeRun(dest, "r3", "done");
    const main = (await execa("git", ["-C", dest, "rev-parse", "HEAD"])).stdout;
    const statePath = path.join(dest, ".graph-execution", "r3", "state.json");
    const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    await writeFile(statePath, JSON.stringify({ ...state, startingCommit: main }));
    await execa("git", ["-C", dest, "branch", "graph/r3"]);
    expect((await status(ws, "r3")).reason).toBe("the run made no changes");

    await store.update((d) => {
      delete d.forges.github;
    });
    expect((await status(ws, "r3")).reason).toBe("GitHub is not connected");
    expect((await req("GET", `/api/runs/${ws}/nope/pr`)).statusCode).toBe(404);
  });

  it("answer 409 to a second POST while a job runs", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    await runBranch(dest, "r1");
    const ws = "github~octo~hello";
    const [a, b] = await Promise.all([req("POST", `/api/runs/${ws}/r1/pr`, { title: "t", body: "" }), req("POST", `/api/runs/${ws}/r1/pr`, { title: "t", body: "" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect((refused.json() as { error: string }).error).toBe("a pull request is already being created");
    expect((await waitForJob(ws, "r1")).job.status).toBe("done");
    expect(forge.pulls).toHaveLength(1);
  });

  it("open a GitLab merge request", async () => {
    await connect("gitlab");
    const dest = await cloneWithRun("gitlab", "grp/sub/proj", "r1", "done");
    await runBranch(dest, "r1");
    const ws = "gitlab~grp~sub~proj";
    const s = await status(ws, "r1");
    expect(s.eligible).toBe(true);
    const done = await createPr(ws, "r1", { title: s.suggested!.title, body: s.suggested!.body });
    expect(done.job).toMatchObject({ status: "done", pr: { number: 1, branch: "graph/r1" } });
    expect(done.job.steps[3]?.detail).toBe("GitLab MR → main");
    expect(JSON.stringify(done)).not.toContain("gl-good");
    expect(forge.pulls).toEqual([expect.objectContaining({ forge: "gitlab", fullPath: "grp/sub/proj", head: "graph/r1", base: "main" })]);
    const files = await execa("git", ["-C", bareOf("grp/sub/proj"), "ls-tree", "-r", "--name-only", "refs/heads/graph/r1"]);
    expect(files.stdout.split("\n")).toContain("hello.txt");
  });
});

describe.skipIf(process.platform === "win32")("Create PR from a terminal worktree (KAN-100)", () => {
  async function waitWt(ws: string, wid: string): Promise<{ job: Job; pr?: { url: string; number: number } }> {
    for (let i = 0; ; i++) {
      const r = (await req("GET", `/api/workspaces/${ws}/worktrees/${wid}/pr`)).json() as { job?: Job; pr?: { url: string; number: number } };
      if (r.job && r.job.status !== "running") return r as { job: Job };
      if (i > 1000) throw new Error("job still running");
      await new Promise((res) => setTimeout(res, 20));
    }
  }

  it("commits the terminal's work, pushes gm-term/<id>, opens the PR, then removes the worktree and keeps the branch", async () => {
    await connect("github");
    const dest = await cloneWithRun("github", "octo/hello", "r1", "done");
    const ws = "github~octo~hello";
    const t = (await req("POST", "/api/terminals", { workspaceId: ws })).json() as { id: string; worktree: { id: string; path: string; branch: string } };
    expect(t.worktree.branch).toBe(`gm-term/${t.worktree.id}`);
    writeFileSync(path.join(t.worktree.path, "work.txt"), "work\n");
    const before = await headOf(dest);

    // A token that can't push: nothing is committed and the worktree stays.
    await execa("git", ["-C", dest, "config", "remote.origin.pushurl", path.join(forge.dir, "nowhere.git")]);
    const start = await req("POST", `/api/terminals/${t.id}/pr`, { title: "Terminal work", body: "b" });
    expect(start.statusCode).toBe(202);
    const failed = await waitWt(ws, t.worktree.id);
    expect(failed.job).toMatchObject({ status: "failed", failedStep: "access" });
    expect((await execa("git", ["-C", t.worktree.path, "status", "--porcelain"])).stdout).toBe("?? work.txt");

    await execa("git", ["-C", dest, "config", "--unset", "remote.origin.pushurl"]);
    expect((await req("POST", `/api/workspaces/${ws}/worktrees/${t.worktree.id}/pr`, { retry: true })).statusCode).toBe(202);
    const done = await waitWt(ws, t.worktree.id);
    expect(done.job.status).toBe("done");
    expect(done.job.steps.map((st) => st.state)).toEqual(["done", "done", "done", "done"]);
    expect(forge.pulls).toEqual([expect.objectContaining({ head: t.worktree.branch, base: "main", title: "Terminal work", body: "b" })]);
    const files = (await execa("git", ["-C", bareOf("octo/hello"), "ls-tree", "-r", "--name-only", `refs/heads/${t.worktree.branch}`])).stdout.split("\n");
    expect(files).toContain("work.txt");
    expect(existsSync(t.worktree.path)).toBe(false);
    expect((await execa("git", ["-C", dest, "branch", "--list", t.worktree.branch])).stdout).not.toBe("");
    expect((await req("GET", "/api/terminals")).json()).toEqual({ terminals: [] });
    expect(store.get().prs[`${ws}/term-${t.worktree.id}`]).toMatchObject({ branch: t.worktree.branch, number: 1 });
    expect(await headOf(dest)).toEqual(before);
  });

  it("refuses a worktree without changes", async () => {
    await connect("github");
    await cloneWithRun("github", "octo/hello", "r1", "done");
    const t = (await req("POST", "/api/terminals", { workspaceId: "github~octo~hello" })).json() as { id: string };
    const res = await req("POST", `/api/terminals/${t.id}/pr`, { title: "x" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("the worktree has no changes");
  });
});

describe("access errors", () => {
  it("recognise a forge refusing the token and say what to fix", () => {
    expect(isAccessDenied("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403")).toBe(true);
    expect(isAccessDenied("remote: Permission to o/r.git denied to bot.")).toBe(true);
    expect(isAccessDenied("fatal: 'origin' does not appear to be a git repository")).toBe(false);
    expect(accessMessage("github", "o/r")).toBe(
      'the GitHub token can\'t push to o/r: give it write access to the repository\'s contents (GitHub: "Contents: Read and write"), then Retry',
    );
  });
});

describe("pushProgress", () => {
  it("reads the last Writing objects percentage of a chunk", () => {
    expect(pushProgress("Enumerating objects: 5, done.\rWriting objects:  12% (1/8)\rWriting objects:  62% (5/8)\r")).toBe(0.62);
    expect(pushProgress("Writing objects: 100% (8/8), 1.2 KiB | 1.2 MiB/s, done.\n")).toBe(1);
    expect(pushProgress("Counting objects: 50%")).toBeUndefined();
  });
});
