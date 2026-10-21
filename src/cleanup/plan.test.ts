import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { plan } from "./plan.js";
import { scan } from "./scan.js";
import { branch, makeRun } from "./scan.test.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ids = (p: Awaited<ReturnType<typeof plan>>) => p.entries.map((e) => e.id);

describe("plan", () => {
  it("selects unfinished runs and orphans, skips live, keeps done", async () => {
    const child = execa(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    child.catch(() => undefined);
    try {
      await makeRun(repo, "r1-unfinished", "running");
      await makeRun(repo, "r2-done", "done");
      await makeRun(repo, "r3-live", "running", child.pid);
      await branch(repo, "graph/old");
      const p = await plan(await scan(repo), { keepRuns: 5 });
      expect(ids(p)).toEqual(["r1-unfinished", "orphans"]);
      expect(p.skipped).toContainEqual({ id: "r3-live", reason: `running (pid ${child.pid})` });
      const withDone = await plan(await scan(repo), { keepRuns: 5, includeDone: true });
      expect(ids(withDone)).toEqual(["r1-unfinished", "r2-done", "orphans"]);
    } finally {
      child.kill();
    }
  });

  it("keepRuns selects the oldest applied runs; retentionOnly only those", async () => {
    for (const id of ["a1", "a2", "a3", "a4"]) await makeRun(repo, id, "applied");
    await makeRun(repo, "u1", "running");
    expect(ids(await plan(await scan(repo), { keepRuns: 2 }))).toEqual(["a1", "a2", "u1"]);
    expect(ids(await plan(await scan(repo), { keepRuns: 2, retentionOnly: true }))).toEqual(["a1", "a2"]);
    expect(ids(await plan(await scan(repo), { keepRuns: 0, retentionOnly: true }))).toEqual([]);
  });

  it("clean <run-id> targets one run and errors when absent", async () => {
    await makeRun(repo, "u1", "running");
    await makeRun(repo, "u2", "running");
    expect(ids(await plan(await scan(repo), { keepRuns: 5, runId: "u2" }))).toEqual(["u2"]);
    await expect(plan(await scan(repo), { keepRuns: 5, runId: "zz" })).rejects.toThrow("no run zz in");
  });

  it("skips a branch checked out outside the run", async () => {
    await makeRun(repo, "u1", "running");
    await branch(repo, "graph/u1");
    const wt = path.join(repo, ".graph-execution", "elsewhere", "wt");
    await mkdir(path.dirname(wt), { recursive: true });
    await gitOut(repo, ["worktree", "add", wt, "graph/u1"]);
    const p = await plan(await scan(repo), { keepRuns: 5 });
    expect(p.entries[0]!.branches).toEqual([]);
    expect(p.skipped.some((s) => s.id === "u1" && s.reason.startsWith("checked out"))).toBe(true);
  });

  it("deletes the branches a run keeps checked out in its own worktrees", async () => {
    await makeRun(repo, "u1", "running");
    await branch(repo, "graph/u1");
    const wt = path.join(repo, ".graph-execution", "u1", "worktrees", "integration");
    await mkdir(path.dirname(wt), { recursive: true });
    await gitOut(repo, ["worktree", "add", wt, "graph/u1"]);
    const p = await plan(await scan(repo), { keepRuns: 5 });
    expect(p.entries[0]!.branches).toEqual(["graph/u1"]);
    expect(p.skipped.some((s) => s.reason.startsWith("checked out"))).toBe(false);
  });

  it("keeps branches with unmerged commits unless forced", async () => {
    await makeRun(repo, "u1", "running");
    await branch(repo, "graph/u1");
    await branch(repo, "graph-task/u1/1");
    await gitOut(repo, ["checkout", "-q", "graph-task/u1/1"]);
    await gitOut(repo, ["commit", "-q", "--allow-empty", "-m", "work"]);
    await gitOut(repo, ["checkout", "-q", "main"]);
    const p = await plan(await scan(repo), { keepRuns: 5 });
    expect(p.entries[0]!.branches).toEqual(["graph/u1"]);
    expect(p.skipped[0]!.reason).toContain("has unmerged commits (use --force)");
    expect(p.skipped[0]!.reason).toContain("graph-task/u1/1");
    const forced = await plan(await scan(repo), { keepRuns: 5, force: true });
    expect(forced.entries[0]!.branches).toEqual(["graph/u1", "graph-task/u1/1"]);
  });
});
