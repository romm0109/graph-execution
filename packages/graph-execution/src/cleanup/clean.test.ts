import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { cleanRuns } from "./clean.js";
import { listWorktrees, removeWorktreeIfPresent } from "../git/git.js";
import { jointRepoDir } from "../suite/joint.js";
import { branch, makeProjectSuite, makeRun, makeSuite } from "./scan.test.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const exists = (p: string) => stat(p).then(() => true, () => false);

async function fixture() {
  await makeRun(repo, "u1", "running");
  await branch(repo, "graph/u1");
  await branch(repo, "graph-task/u1/1");
  const wt = path.join(repo, ".graph-execution", "u1", "worktrees", "task-1-a1");
  await mkdir(path.dirname(wt), { recursive: true });
  await gitOut(repo, ["worktree", "add", "-q", "--detach", wt, "graph-task/u1/1"]);
  await branch(repo, "graph/orphan");
  return wt;
}

describe("cleanRuns", () => {
  it("with yes deletes folders, worktrees and branches, leaving main and live runs", async () => {
    const child = execa(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    child.catch(() => undefined);
    try {
      const wt = await fixture();
      await makeRun(repo, "live", "running", child.pid);
      const out: string[] = [];
      expect(await cleanRuns({ cwd: repo, yes: true, out: (t) => out.push(t) })).toBe(0);
      expect(await exists(path.join(repo, ".graph-execution", "u1"))).toBe(false);
      expect(await exists(path.join(repo, ".graph-execution", "live"))).toBe(true);
      expect(await gitOut(repo, ["worktree", "list"])).not.toContain(wt);
      const branches = await gitOut(repo, ["branch", "--format=%(refname:short)"]);
      expect(branches.split("\n")).toEqual(["main"]);
      expect(out.join("\n")).toContain("Frees");
    } finally {
      child.kill();
    }
  });

  it("deletes nothing when confirm says no", async () => {
    await fixture();
    const out: string[] = [];
    expect(await cleanRuns({ cwd: repo, confirm: async () => false, out: (t) => out.push(t) })).toBe(0);
    expect(out).toContain("Nothing deleted.");
    expect(await exists(path.join(repo, ".graph-execution", "u1"))).toBe(true);
    expect(await gitOut(repo, ["branch", "--list", "graph/u1"])).not.toBe("");
  });

  it("prints Nothing to clean.", async () => {
    const out: string[] = [];
    expect(await cleanRuns({ cwd: repo, yes: true, out: (t) => out.push(t) })).toBe(0);
    expect(out).toEqual(["Nothing to clean."]);
  });

  it("never selects a live suite", async () => {
    const child = execa(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    child.catch(() => undefined);
    try {
      const dir = await makeSuite(repo, "20260103-000000-cd34", "running", ["lf-1", "lf-2"], child.pid);
      await branch(repo, "graph/lf-1");
      await cleanRuns({ cwd: repo, yes: true, out: () => undefined });
      expect(await exists(dir)).toBe(true);
      expect(await gitOut(repo, ["branch", "--list", "graph/lf-1"])).toContain("graph/lf-1");
    } finally {
      child.kill();
    }
  });

  it("deletes an unfinished suite's worktrees, branches and folder", async () => {
    const dir = await makeSuite(repo, "20260104-000000-ef56", "running", ["uf-1", "uf-2"]);
    for (const b of ["suite/20260104-000000-ef56", "graph/uf-1", "graph/uf-2", "graph-task/uf-1/1"]) await branch(repo, b);
    const wt = path.join(dir, "features", "uf-1", "worktrees", "task-1-a1");
    await mkdir(path.dirname(wt), { recursive: true });
    await gitOut(repo, ["worktree", "add", "-q", "--detach", wt, "graph-task/uf-1/1"]);
    expect(await cleanRuns({ cwd: repo, yes: true, out: () => undefined })).toBe(0);
    expect(await exists(dir)).toBe(false);
    expect(await gitOut(repo, ["worktree", "list"])).not.toContain(wt);
    expect((await gitOut(repo, ["branch", "--format=%(refname:short)"])).split("\n")).toEqual(["main"]);
  });

  it("says which branches it keeps without calling a deleted run skipped", async () => {
    await makeRun(repo, "u1", "running");
    await branch(repo, "graph/u1");
    await branch(repo, "graph-task/u1/1");
    await gitOut(repo, ["checkout", "-q", "graph-task/u1/1"]);
    await gitOut(repo, ["commit", "-q", "--allow-empty", "-m", "work"]);
    await gitOut(repo, ["checkout", "-q", "main"]);
    const out: string[] = [];
    expect(await cleanRuns({ cwd: repo, yes: true, out: (t) => out.push(t) })).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("Skipped u1");
    expect(text).toMatch(/^u1 .* 1 branches\n {2}keeps branches unmerged commits \(use --force\): graph-task\/u1\/1$/m);
    expect(text).toMatch(/^deleted u1 \(.*\); kept branches unmerged commits \(use --force\): graph-task\/u1\/1$/m);
    expect(await exists(path.join(repo, ".graph-execution", "u1"))).toBe(false);
    expect((await gitOut(repo, ["branch", "--format=%(refname:short)"])).split("\n")).toEqual(["graph-task/u1/1", "main"]);
  });
});

describe("cleanRuns of a multi-repo suite", () => {
  const rid = "20260104-000000-gh78";
  let api: string;
  let web: string;
  beforeEach(async () => {
    api = await tempRepo();
    web = await tempRepo();
  });
  afterEach(async () => {
    for (const d of [api, web]) {
      for (const w of await listWorktrees(d)) if (w.path !== path.resolve(d)) await removeWorktreeIfPresent(d, w.path).catch(() => {});
      await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const repos = () => [
    { name: "api", path: api },
    { name: "web", path: web },
  ];
  const features = [
    { runId: "run-api", repo: "api" },
    { runId: "run-web", repo: "web" },
  ];
  const branchesOf = async (r: string) => (await gitOut(r, ["branch", "--format=%(refname:short)"])).split("\n");
  const linkOf = (r: string) => path.join(r, ".graph-execution", "_projects", `suite-${rid}.json`);

  /** In each repo `suite/<rid>` checked out in its joint worktree; in api a feature's branches and a task worktree. */
  async function fixture(status: string): Promise<string> {
    const dir = await makeProjectSuite(repo, rid, status, repos(), features);
    for (const r of repos()) {
      const wt = jointRepoDir(dir, r.name);
      await mkdir(path.dirname(wt), { recursive: true });
      await gitOut(r.path, ["worktree", "add", "-q", "-b", `suite/${rid}`, wt]);
    }
    await branch(api, "graph/run-api");
    await branch(api, "graph-task/run-api/1");
    const task = path.join(dir, "features", "run-api", "worktrees", "task-1");
    await mkdir(path.dirname(task), { recursive: true });
    await gitOut(api, ["worktree", "add", "-q", task, "graph-task/run-api/1"]);
    return dir;
  }

  it("clean <suite-id> removes the suite's branches and worktrees in every repo", async () => {
    const dir = await fixture("applied");
    const out: string[] = [];
    expect(await cleanRuns({ cwd: repo, runId: `suite-${rid}`, yes: true, out: (t) => out.push(t) })).toBe(0);
    expect(out.join("\n")).toContain(`suite-${rid}  requested`);
    expect(out.join("\n")).toContain("4 branches");
    expect(await exists(dir)).toBe(false);
    for (const r of [api, web]) {
      expect(await branchesOf(r)).toEqual(["main"]);
      expect(await gitOut(r, ["worktree", "list"])).not.toContain(`suite-${rid}`);
      expect(await exists(linkOf(r))).toBe(false);
    }
  });

  it("keeps the unmerged suite branches of a done multi-repo suite", async () => {
    const dir = await fixture("done");
    await writeFile(path.join(jointRepoDir(dir, "web"), "x.txt"), "x\n");
    await gitOut(jointRepoDir(dir, "web"), ["add", "x.txt"]);
    await gitOut(jointRepoDir(dir, "web"), ["commit", "-q", "-m", "joint fix"]);
    const out: string[] = [];
    expect(await cleanRuns({ cwd: repo, runId: `suite-${rid}`, yes: true, out: (t) => out.push(t) })).toBe(0);
    expect(out.join("\n")).toContain(`web: unmerged commits (use --force): suite/${rid}`);
    expect(await exists(dir)).toBe(false);
    expect(await branchesOf(web)).toEqual(["main", `suite/${rid}`]);
    expect(await branchesOf(api)).toEqual(["main"]);

    // --force on the remaining orphan in web, from web itself.
    expect(await cleanRuns({ cwd: web, yes: true, force: true, out: () => {} })).toBe(0);
    expect(await branchesOf(web)).toEqual(["main"]);
  });

  it("deletes the unmerged suite branches with --force", async () => {
    const dir = await fixture("done");
    await writeFile(path.join(jointRepoDir(dir, "web"), "x.txt"), "x\n");
    await gitOut(jointRepoDir(dir, "web"), ["add", "x.txt"]);
    await gitOut(jointRepoDir(dir, "web"), ["commit", "-q", "-m", "joint fix"]);
    expect(await cleanRuns({ cwd: repo, runId: `suite-${rid}`, yes: true, force: true, out: () => {} })).toBe(0);
    expect(await branchesOf(web)).toEqual(["main"]);
  });

  it("skips a live multi-repo suite", async () => {
    const child = execa(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    child.catch(() => undefined);
    try {
      const dir = await makeProjectSuite(repo, rid, "running", repos(), features, child.pid);
      await branch(api, `suite/${rid}`);
      const out: string[] = [];
      expect(await cleanRuns({ cwd: repo, yes: true, out: (t) => out.push(t) })).toBe(0);
      expect(out.join("\n")).toContain(`Skipped suite-${rid}: running (pid ${child.pid})`);
      expect(await exists(dir)).toBe(true);
      expect(await branchesOf(api)).toContain(`suite/${rid}`);
    } finally {
      child.kill();
    }
  });

  it("a member repo does not orphan a linked suite's branches", async () => {
    const dir = await makeProjectSuite(repo, rid, "done", repos(), features);
    await branch(api, `suite/${rid}`);
    await branch(api, "graph/run-api");
    const out: string[] = [];
    expect(await cleanRuns({ cwd: api, yes: true, out: (t) => out.push(t) })).toBe(0);
    expect(out).toEqual(["Nothing to clean."]);
    expect(await branchesOf(api)).toEqual(["graph/run-api", "main", `suite/${rid}`]);

    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(await exists(linkOf(api))).toBe(true);
    expect(await cleanRuns({ cwd: api, yes: true, out: () => {} })).toBe(0);
    expect(await branchesOf(api)).toEqual(["main"]);
    expect(await exists(linkOf(api))).toBe(false);
  });
});
