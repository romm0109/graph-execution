import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { cleanRuns } from "./clean.js";
import { branch, makeRun, makeSuite, makeTwoRepoSuite } from "./scan.test.js";

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

  it("clean <suite-id> from a non-repo home removes the branches, pointers and folder in every repo", async () => {
    const s = await makeTwoRepoSuite();
    try {
      expect(await cleanRuns({ cwd: s.home, runId: s.suiteId, yes: true, out: () => {} })).toBe(0);
      for (const r of [s.a, s.b]) {
        expect((await gitOut(r, ["branch", "--format=%(refname:short)"])).split("\n")).toEqual(["main"]);
        expect(await exists(path.join(r, ".graph-execution", "_suites", `${s.suiteId}.json`))).toBe(false);
      }
      expect(await exists(s.dir)).toBe(false);
    } finally {
      await s.cleanup();
    }
  });

  it("warns about a missing repo and still deletes the rest", async () => {
    const s = await makeTwoRepoSuite();
    try {
      await rm(s.b, { recursive: true, force: true });
      const out: string[] = [];
      expect(await cleanRuns({ cwd: s.home, runId: s.suiteId, yes: true, out: (t) => out.push(t) })).toBe(0);
      expect(out).toContain(`${s.suiteId}: repo ${s.b} not found; skipped`);
      expect((await gitOut(s.a, ["branch", "--format=%(refname:short)"])).split("\n")).toEqual(["main"]);
      expect(await exists(s.dir)).toBe(false);
    } finally {
      await s.cleanup();
    }
  });
});
