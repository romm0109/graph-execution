import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { createFakeProvider } from "../providers/fake.js";
import { resume } from "./run.js";
import { assertNotNested, startup } from "./startup.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A worktree of `repo` where a run would put a task's: `.graph-execution/<run-id>/worktrees/task-1-a1`. */
async function runWorktree(): Promise<string> {
  const wt = path.join(repo, ".graph-execution", "20260101-000000-abcd", "worktrees", "task-1-a1");
  await mkdir(path.dirname(wt), { recursive: true });
  await execa("git", ["worktree", "add", "-q", "--detach", wt], { cwd: repo });
  return wt;
}

describe("assertNotNested", () => {
  it.each([
    "/home/u/project/.graph-execution/r/worktrees/task-1-a1",
    "C:/Users/u/project/.graph-execution/r/worktrees/task-1-a1",
    "C:\\Users\\u\\project\\.graph-execution\\r\\worktrees\\task-1-a1",
  ])("refuses %s", (repoPath) => {
    expect(() => assertNotNested(repoPath)).toThrow(/inside a graph-execution worktree/);
  });

  it.each(["/home/u/project", "C:/Users/u/graph-execution", "/home/u/.graph-execution-notes"])(
    "allows %s",
    (repoPath) => {
      expect(() => assertNotNested(repoPath)).not.toThrow();
    },
  );
});

describe("nested runs", () => {
  it("startup refuses to run in one of a run's worktrees", async () => {
    const wt = await runWorktree();
    await expect(
      startup({ cwd: wt, provider: "fake", providerInstance: createFakeProvider({}), log: () => {} }),
    ).rejects.toThrow(/inside a graph-execution worktree/);
  });

  it("resume refuses to run in one of a run's worktrees", async () => {
    const wt = await runWorktree();
    await expect(resume({ cwd: wt, log: () => {} })).rejects.toThrow(/inside a graph-execution worktree/);
  });

  it("startup still runs in the repository itself", async () => {
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: createFakeProvider({}), log: () => {} });
    expect(ctx.runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
  });
});
