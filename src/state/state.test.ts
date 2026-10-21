import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewStateSchema, computeHashes, initialReviewState, StateStore, taskStateSchema, type RunState } from "./state.js";

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
  humanReview: false,
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

  it("loads a state saved without humanReview as false", async () => {
    const file = path.join(dir, "state.json");
    const old: Partial<RunState> = initial();
    delete old.humanReview;
    await writeFile(file, JSON.stringify(old));
    expect((await StateStore.load(file)).state.humanReview).toBe(false);
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

describe("computeHashes tasks hash", () => {
  it("ignores test-plan.json but not task files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ge-hash-"));
    try {
      await writeFile(path.join(dir, "1.json"), '{"id":"1","content":"a"}');
      await writeFile(path.join(dir, "test-plan.json"), "{}");
      const hash = async () => (await computeHashes(path.join(dir, "none"), dir, path.join(dir, "none"))).tasks;
      const before = await hash();
      await writeFile(path.join(dir, "test-plan.json"), '{"cases":[]}');
      expect(await hash()).toBe(before);
      await writeFile(path.join(dir, "1.json"), '{"id":"1","content":"b"}');
      expect(await hash()).not.toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("review state", () => {
  it("parses an old review state without the human review fields", () => {
    const old = { phase: "done", round: 1, validationRounds: 0, reports: {} };
    expect(reviewStateSchema.parse(old)).toMatchObject({ humanRound: 0, budgetBase: 0 });
  });

  it("accepts the human step", () => {
    expect(reviewStateSchema.parse({ ...initialReviewState(), phase: "human", humanRound: 1 }).phase).toBe("human");
  });
});
