import { mkdir, rm, writeFile } from "node:fs/promises";
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

describe("startup with a custom runs root and run id", () => {
  const base = { provider: "fake", providerInstance: createFakeProvider({}), log: () => {} };

  it("puts the run folder under the root with the forced id", async () => {
    const root = path.join(repo, "custom", "features");
    const env = { GRAPH_EXECUTION_RUNS_ROOT: root, GRAPH_EXECUTION_RUN_ID: "20260101-000000-abcd" };
    const ctx = await startup({ ...base, cwd: repo, env });
    expect(ctx.runId).toBe("20260101-000000-abcd");
    expect(ctx.runDir).toBe(path.join(root, "20260101-000000-abcd"));
  });

  it("refuses an invalid run id", async () => {
    await expect(startup({ ...base, cwd: repo, env: { GRAPH_EXECUTION_RUN_ID: "../x" } })).rejects.toThrow(
      /invalid GRAPH_EXECUTION_RUN_ID/,
    );
  });

  it("refuses a run id that already has a state.json", async () => {
    const root = path.join(repo, "custom");
    await mkdir(path.join(root, "r1"), { recursive: true });
    await writeFile(path.join(root, "r1", "state.json"), "{}");
    const env = { GRAPH_EXECUTION_RUNS_ROOT: root, GRAPH_EXECUTION_RUN_ID: "r1" };
    await expect(startup({ ...base, cwd: repo, env })).rejects.toThrow(/run r1 already exists/);
  });
});
