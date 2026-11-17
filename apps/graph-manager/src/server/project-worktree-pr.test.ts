// Create PR for a project terminal (docs/prd/project-terminal-worktrees.md): one linked PR per repo with work.
import { existsSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../scripts/fake-forge.mjs";
import type { Config } from "./config.js";
import type { DataStore } from "./store.js";
import { appWithLogin } from "./test-helpers.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let config: Config;
let store: DataStore;
let cleanup: () => Promise<void>;

const req = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const wsDirOf = (name: string) => path.join(config.workspacesDir, "github", "acme", name);
const bareOf = (fullPath: string): string => path.join(forge.dir, `${fullPath}.git`);
const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd })).stdout.trim();

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
interface Term {
  id: string;
  cwd: string;
  worktree: { id: string; path: string; branch: string; repos: { name: string; baseBranch?: string; isolated: boolean }[] };
}

const repoOf = (job: Job, name: string): JobRepo => job.repos.find((r) => r.name === name)!;

async function open(): Promise<Term> {
  const res = await req("POST", "/api/terminals", { projectId: "billing" });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Term;
}

async function wait(wid: string, jobId: string): Promise<{ job: Job; prs?: Record<string, { url: string; number: number; branch: string; base?: string }> }> {
  for (let i = 0; ; i++) {
    const r = (await req("GET", `/api/projects/billing/worktrees/${wid}/pr`)).json() as { job?: Job; prs?: Record<string, { url: string; number: number; branch: string }> };
    if (r.job && r.job.id === jobId && r.job.status !== "running") return r as { job: Job };
    if (i > 1000) throw new Error(`job still running: ${JSON.stringify(r.job)}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

async function start(url: string, payload: object): Promise<Job> {
  const res = await req("POST", url, payload);
  expect(res.statusCode, res.body).toBe(202);
  return (res.json() as { job: Job }).job;
}

beforeEach(async () => {
  forge = await startFakeForge();
  ({ app, cookie, config, store, cleanup } = await appWithLogin({ githubApiUrl: `${forge.url}/github` }));
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
  for (const n of ["a", "b", "c"]) await clone(`acme/${n}`);
  const made = await req("POST", "/api/projects", { name: "billing", workspaces: ["github~acme~a", "github~acme~b", "github~acme~c"] });
  expect(made.statusCode, made.body).toBe(201);
}, 30_000);

afterEach(async () => {
  await cleanup();
  await forge.close();
});

describe.skipIf(process.platform === "win32")("Create PR for a project terminal", () => {
  it("opens one linked PR per repo with work, skips the others, removes the repo worktrees and keeps the branches", async () => {
    const t = await open();
    const wid = t.worktree.id;
    const branch = `gm-term/${wid}`;
    await writeFile(path.join(t.cwd, "repos", "a", "a.txt"), "a\n");
    await writeFile(path.join(t.cwd, "repos", "b", "b.txt"), "b\n");

    const job = await start(`/api/terminals/${t.id}/pr`, { title: "Cross-repo work", body: "Body.", bases: { a: "main", b: "main" } });
    expect(job.repos.map((r) => [r.name, r.status])).toEqual([
      ["a", expect.any(String)],
      ["b", expect.any(String)],
      ["c", "skipped"],
    ]);
    const done = await wait(wid, job.id);
    expect(done.job, JSON.stringify(done.job)).toMatchObject({ status: "done", link: { state: "done" } });
    expect(done.job.repos.map((r) => r.status)).toEqual(["done", "done", "skipped"]);
    expect(JSON.stringify(done)).not.toContain("gh-good");

    expect(forge.pulls).toHaveLength(2);
    expect(forge.pulls.every((p) => p.head === branch && p.base === "main" && p.title === "Cross-repo work")).toBe(true);
    const a = forge.pulls.find((p) => p.fullPath === "acme/a")!;
    const b = forge.pulls.find((p) => p.fullPath === "acme/b")!;
    expect(a.body).toContain("Body.");
    expect(a.body).toContain(`acme/b#${b.number}`);
    expect(b.body).toContain(`acme/a#${a.number}`);
    expect(done.prs).toMatchObject({ a: { number: a.number, branch }, b: { number: b.number, branch } });

    for (const n of ["a", "b"]) {
      expect(existsSync(path.join(wsDirOf(n), ".gm-worktrees", wid))).toBe(false);
      expect(await git(wsDirOf(n), "branch", "--list", branch)).toContain(branch);
      expect(await git(bareOf(`acme/${n}`), "ls-tree", "-r", "--name-only", `refs/heads/${branch}`)).toContain(`${n}.txt`);
    }
    expect(existsSync(path.join(wsDirOf("c"), ".gm-worktrees", wid))).toBe(false);
    expect(await git(wsDirOf("c"), "branch", "--list", branch)).toContain(branch);
    expect(await git(bareOf("acme/c"), "branch", "--list", branch)).toBe("");
    // Nothing left in the project repo either, and the terminal is gone.
    expect(existsSync(t.cwd)).toBe(false);
    expect(store.get().projectWorktrees[wid]).toBeUndefined();
    expect((await req("GET", "/api/terminals")).json()).toEqual({ terminals: [] });
  });

  it("fails on one repo, then Retry reuses the PR already open and links both", async () => {
    const t = await open();
    const wid = t.worktree.id;
    await writeFile(path.join(t.cwd, "repos", "a", "a.txt"), "a\n");
    await writeFile(path.join(t.cwd, "repos", "b", "b.txt"), "b\n");
    rmSync(bareOf("acme/b"), { recursive: true, force: true });

    const first = await wait(wid, (await start(`/api/projects/billing/worktrees/${wid}/pr`, { title: "Work" })).id);
    expect(first.job.status).toBe("failed");
    expect(repoOf(first.job, "a").status).toBe("done");
    expect(repoOf(first.job, "b").status).toBe("failed");
    expect(first.job.error).toMatch(/b: /);
    expect(first.job.link.state).not.toBe("done");
    expect(forge.pulls).toHaveLength(1);
    expect(existsSync(path.join(wsDirOf("a"), ".gm-worktrees", wid))).toBe(true);
    expect(store.get().projectWorktrees[wid]).toBeDefined();

    forge.addRepo("acme/b", "github");
    const second = await wait(wid, (await start(`/api/projects/billing/worktrees/${wid}/pr`, { retry: true })).id);
    expect(second.job, JSON.stringify(second.job)).toMatchObject({ status: "done", link: { state: "done" } });
    expect(repoOf(second.job, "a").status).toBe("skipped");
    expect(repoOf(second.job, "a").steps.every((s) => s.detail === "already open")).toBe(true);
    expect(repoOf(second.job, "b").status).toBe("done");
    expect(forge.pulls).toHaveLength(2);
    const a = forge.pulls.find((p) => p.fullPath === "acme/a")!;
    const b = forge.pulls.find((p) => p.fullPath === "acme/b")!;
    expect(b.title).toBe("Work");
    expect(a.body).toContain(`acme/b#${b.number}`);
    expect(b.body).toContain(`acme/a#${a.number}`);
  });

  it("keeps the project-repo worktree when it still holds work", async () => {
    const t = await open();
    const wid = t.worktree.id;
    await writeFile(path.join(t.cwd, "repos", "a", "a.txt"), "a\n");
    await writeFile(path.join(t.cwd, "notes.md"), "notes\n");
    const done = await wait(wid, (await start(`/api/terminals/${t.id}/pr`, {})).id);
    expect(done.job.status).toBe("done");
    expect(forge.pulls).toHaveLength(1);
    expect(forge.pulls[0]?.body).not.toContain("## Related PRs");
    const rec = store.get().projectWorktrees[wid];
    expect(rec).toMatchObject({ kept: true });
    expect(rec?.terminalId).toBeUndefined();
    expect(rec?.repos.some((r) => r.isolated)).toBe(false);
    expect(existsSync(path.join(t.cwd, "notes.md"))).toBe(true);
    expect(existsSync(path.join(wsDirOf("a"), ".gm-worktrees", wid))).toBe(false);
  });

  it("refuses when no repo has changes", async () => {
    const t = await open();
    const res = await req("POST", `/api/terminals/${t.id}/pr`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "no repo has changes" });
    const retry = await req("POST", `/api/projects/billing/worktrees/${t.worktree.id}/pr`, { retry: true });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: "no failed Create PR to retry" });
  });
});
