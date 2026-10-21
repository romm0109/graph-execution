import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialReviewState, StateStore, taskStateSchema, type RunState } from "./state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const initial = (): RunState => ({
  runId: "20260101-000000-abcd",
  provider: "fake",
  startingCommit: "abc",
  integrationBranch: "graph/20260101-000000-abcd",
  specPath: "/spec.md",
  tasksDir: "/tasks",
  hashes: { config: "", tasks: "t", spec: "s" },
  review: initialReviewState(),
  tasks: { "1": { status: "pending", attempts: 0 } },
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("StateStore", () => {
  it("saves atomically and loads back", async () => {
    const file = path.join(dir, "state.json");
    const store = new StateStore(file, initial());
    await store.update((s) => {
      s.tasks["1"] = { status: "merged", attempts: 1, mergeCommit: "def" };
    });
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect((await StateStore.load(file)).state.tasks["1"]).toEqual({ status: "merged", attempts: 1, mergeCommit: "def" });
  });

  it("refuses to save an invalid state", async () => {
    const store = new StateStore(path.join(dir, "state.json"), initial());
    (store.state.tasks["1"] as { status: string }).status = "bogus";
    await expect(store.save()).rejects.toThrow();
  });
});

describe("baseSha", () => {
  it("is optional: a task state without it still parses", () => {
    expect(taskStateSchema.parse({ status: "merged", attempts: 1 }).baseSha).toBeUndefined();
    expect(taskStateSchema.parse({ status: "running", attempts: 1, baseSha: "abc" }).baseSha).toBe("abc");
  });
});
