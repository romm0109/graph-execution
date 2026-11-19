import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Task, taskSchema } from "../graph/task.js";
import { initialReviewState, StateStore, type TaskState } from "../state/state.js";
import { applyResolution, checkResolution, decisionSection, ResolutionError, type ResolutionInput } from "./resolve.js";
import type { EscalationRecord } from "./schema.js";
import { loadEscalations, saveEscalation } from "./store.js";

const task = (id: string, dependencies: string[] = []): Task => taskSchema.parse({ id, content: `Do ${id}.`, dependencies });
const TASKS = [task("1"), task("2", ["1"]), task("3", ["1"]), task("4", ["2", "3"])];

const record = (id: string, node: string, status: "open" | "resolved" = "open"): EscalationRecord => ({
  id,
  node,
  status,
  source: "agent",
  attempt: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  reason: `reason ${id}`,
  evidence: "e",
  questions: [{ id: "q1", question: "A or B?" }],
});

const states = (s: Record<string, TaskState["status"]>): Record<string, TaskState> =>
  Object.fromEntries(Object.entries(s).map(([id, status]) => [id, { status, attempts: 1 }]));

const input = (over: Partial<ResolutionInput> = {}): ResolutionInput => ({
  tasks: TASKS,
  states: states({ "1": "merged", "2": "escalated", "3": "merged", "4": "pending" }),
  escalations: [record("E1", "2")],
  usedIds: ["1", "2", "3", "4"],
  ...over,
});

const refused = (fn: () => unknown): { status: number; code: string; message: string } => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ResolutionError) return { status: err.status, code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a ResolutionError");
};

describe("checkResolution", () => {
  it("continue requeues the escalated task and keeps the task set", () => {
    const r = checkResolution(input(), { escalationIds: ["E1"], action: "continue", guidance: "use B" });
    expect(r.requeue).toEqual(["2"]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.tasks).toBe(TASKS);
  });

  it("change edits, adds, removes and reopens", () => {
    const r = checkResolution(
      input({ states: states({ "1": "merged", "2": "escalated", "3": "pending", "4": "pending" }) }),
      {
        escalationIds: ["E1"],
        action: "change",
        editTasks: [{ id: "4", content: "Do 4 differently.", dependencies: ["2"] }],
        addTasks: [{ id: "5", content: "Do 5.", dependencies: ["4"] }],
        removeTasks: ["3"],
        reopen: ["1"],
      },
    );
    expect(r.changed).toBe(true);
    expect(r.requeue).toEqual(["2", "1"]);
    expect(r.removed).toEqual(["3"]);
    expect(r.tasks.map((t) => t.id)).toEqual(["1", "2", "4", "5"]);
    expect(r.tasks.find((t) => t.id === "4")).toEqual({ id: "4", content: "Do 4 differently.", dependencies: ["2"] });
    expect(r.tasks.find((t) => t.id === "5")!.dependencies).toEqual(["4"]);
  });

  it("change that removes the escalated task does not requeue it", () => {
    const r = checkResolution(input(), {
      escalationIds: ["E1"],
      action: "change",
      removeTasks: ["2"],
      editTasks: [{ id: "4", dependencies: ["3"] }],
    });
    expect(r.requeue).toEqual([]);
    expect(r.removed).toEqual(["2"]);
  });

  it("abort requeues the escalated nodes but takes no task changes", () => {
    expect(checkResolution(input(), { escalationIds: ["E1"], action: "abort" }).changed).toBe(false);
    expect(refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "abort", reopen: ["1"] })).code).toBe("invalid");
  });

  it("400 invalid: schema errors and task fields with continue", () => {
    expect(refused(() => checkResolution(input(), { escalationIds: [], action: "continue" }))).toMatchObject({ status: 400, code: "invalid" });
    expect(refused(() => checkResolution(input(), { escalationIds: ["X1"], action: "continue" }))).toMatchObject({ status: 400, code: "invalid" });
    expect(refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "go" }))).toMatchObject({ status: 400, code: "invalid" });
    expect(refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "continue", reopen: ["1"] }))).toEqual({
      status: 400,
      code: "invalid",
      message: '"continue" takes no task changes',
    });
  });

  it("400 invalid: unknown edited, removed or reopened tasks, and answers to other escalations", () => {
    for (const body of [
      { editTasks: [{ id: "9", content: "x" }] },
      { removeTasks: ["9"] },
      { reopen: ["9"] },
      { answers: [{ escalationId: "E2", questionId: "q1", answer: "A" }] },
      { answers: [{ escalationId: "E1", questionId: "q9", answer: "A" }] },
    ]) {
      expect(refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "change", ...body }))).toMatchObject({
        status: 400,
        code: "invalid",
      });
    }
  });

  it("409 not_open: unknown or resolved escalations", () => {
    expect(refused(() => checkResolution(input(), { escalationIds: ["E2"], action: "continue" }))).toMatchObject({ status: 409, code: "not_open" });
    const resolved = input({ escalations: [record("E1", "2", "resolved")] });
    expect(refused(() => checkResolution(resolved, { escalationIds: ["E1"], action: "continue" }))).toMatchObject({
      status: 409,
      code: "not_open",
    });
  });

  it("409 task_started: an edited or removed task that is not pending or escalated", () => {
    expect(
      refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "change", editTasks: [{ id: "1", content: "x" }] })),
    ).toEqual({ status: 409, code: "task_started", message: "task 1 has started (merged)" });
    const running = input({ states: states({ "1": "merged", "2": "escalated", "3": "running", "4": "pending" }) });
    expect(refused(() => checkResolution(running, { escalationIds: ["E1"], action: "change", removeTasks: ["3"] }))).toMatchObject({
      status: 409,
      code: "task_started",
    });
  });

  it("409 not_merged: a reopened task that is not merged", () => {
    expect(refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "change", reopen: ["4"] }))).toMatchObject({
      status: 409,
      code: "not_merged",
    });
  });

  it("400 duplicate_id: an added id that exists or existed", () => {
    for (const id of ["3", "0"]) {
      expect(
        refused(() =>
          checkResolution(input({ usedIds: ["0", "1", "2", "3", "4"] }), {
            escalationIds: ["E1"],
            action: "change",
            addTasks: [{ id, content: "x" }],
          }),
        ),
      ).toMatchObject({ status: 400, code: "duplicate_id" });
    }
  });

  it("400 graph: a cycle, an unknown dependency, or a kept task depending on a removed one", () => {
    const cycle = refused(() =>
      checkResolution(input(), { escalationIds: ["E1"], action: "change", editTasks: [{ id: "2", dependencies: ["4"] }] }),
    );
    expect(cycle).toMatchObject({ status: 400, code: "graph" });
    expect(cycle.message).toContain("cycle");
    expect(
      refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "change", addTasks: [{ id: "5", content: "x", dependencies: ["9"] }] })),
    ).toMatchObject({ status: 400, code: "graph" });
    expect(refused(() => checkResolution(input(), { escalationIds: ["E1"], action: "change", removeTasks: ["2"] }))).toEqual({
      status: 400,
      code: "graph",
      message: 'task "4" depends on removed task "2"',
    });
  });
});

describe("decisionSection", () => {
  it("gives the reason, the questions with their answers, the guidance and the reopen note", () => {
    const text = decisionSection({
      escalations: [record("E1", "2")],
      resolution: {
        escalationIds: ["E1"],
        action: "continue",
        guidance: "use B",
        answers: [{ escalationId: "E1", questionId: "q1", answer: "B" }],
      },
      reopened: true,
    }).join("\n");
    expect(text).toContain("## Decision");
    expect(text).toContain("reason E1");
    expect(text).toContain("A or B?");
    expect(text).toContain("Answer: B");
    expect(text).toContain("use B");
    expect(text).toContain("Your earlier work for this task is already merged into this checkout.");
  });
});

describe("applyResolution", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function setup() {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "resolve-"));
    dirs.push(runDir);
    const store = new StateStore(path.join(runDir, "state.json"), {
      runId: "r",
      provider: "fake",
      startingCommit: "abc",
      integrationBranch: "graph/r",
      humanReview: false,
      escalation: true,
      escalations: [{ id: "E1", node: "2", status: "open" }],
      tasksSource: "folder",
      specPath: path.join(runDir, "spec.md"),
      tasksDir: path.join(runDir, "user-tasks"),
      hashes: { config: "", tasks: "", spec: "", reviewers: "" },
      tasks: {
        "1": { status: "merged", attempts: 1, branch: "b1", mergeCommit: "m1" },
        "2": { status: "escalated", attempts: 2, branch: "b2" },
        "3": { status: "merged", attempts: 1, mergeCommit: "m3" },
        "4": { status: "pending", attempts: 0 },
      },
      review: initialReviewState(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.save();
    await saveEscalation(runDir, record("E1", "2"));
    return { runDir, store };
  }

  it("continue resets the escalated task and resolves the escalation without writing tasks", async () => {
    const { runDir, store } = await setup();
    const { update } = await applyResolution(runDir, store, TASKS, { escalationIds: ["E1"], action: "continue", guidance: "g" });
    expect(update).toEqual({ tasks: TASKS, requeue: ["2"], removed: [] });
    expect(store.state.tasks["2"]).toEqual({ status: "pending", attempts: 0 });
    expect(store.state.tasksSource).toBe("folder");
    expect(store.state.escalations).toEqual([{ id: "E1", node: "2", status: "resolved" }]);
    const [e1] = await loadEscalations(runDir);
    expect(e1).toMatchObject({ status: "resolved", resolution: { action: "continue", guidance: "g" } });
    expect(e1!.resolvedAt).toBeDefined();
    expect((await readdir(runDir)).includes("tasks")).toBe(false);
  });

  it("change writes the run's task copy and updates the state", async () => {
    const { runDir, store } = await setup();
    const { update } = await applyResolution(runDir, store, TASKS, {
      escalationIds: ["E1"],
      action: "change",
      addTasks: [{ id: "5", content: "Do 5.", dependencies: ["4"] }],
      reopen: ["1"],
    });
    expect(update.requeue).toEqual(["2", "1"]);
    expect((await readdir(path.join(runDir, "tasks"))).sort()).toEqual(["1.json", "2.json", "3.json", "4.json", "5.json"]);
    expect(JSON.parse(await readFile(path.join(runDir, "tasks", "5.json"), "utf8"))).toEqual({ id: "5", content: "Do 5.", dependencies: ["4"] });
    expect(store.state.tasksSource).toBe("run");
    expect(store.state.tasks["5"]).toEqual({ status: "pending", attempts: 0 });
    expect(store.state.tasks["1"]).toEqual({ status: "pending", attempts: 0, branch: "b1", mergeCommit: "m1" });
    // A removed id can never come back.
    await saveEscalation(runDir, record("E2", "5"));
    store.state.escalations.push({ id: "E2", node: "5", status: "open" });
    store.state.tasks["5"]!.status = "escalated";
    await applyResolution(runDir, store, update.tasks, { escalationIds: ["E2"], action: "change", removeTasks: ["5"] });
    expect(store.state.tasks["5"]).toBeUndefined();
    expect(await readdir(path.join(runDir, "tasks"))).not.toContain("5.json");
    await saveEscalation(runDir, record("E3", "4"));
    await expect(
      applyResolution(runDir, store, TASKS, { escalationIds: ["E3"], action: "change", addTasks: [{ id: "5", content: "again" }] }),
    ).rejects.toMatchObject({ code: "duplicate_id" });
  });

  it("abort only resolves the escalations", async () => {
    const { runDir, store } = await setup();
    const { update } = await applyResolution(runDir, store, TASKS, { escalationIds: ["E1"], action: "abort" });
    expect(update).toEqual({ tasks: TASKS, requeue: [], removed: [] });
    expect(store.state.tasks["2"]!.status).toBe("escalated");
    expect(store.state.escalations[0]!.status).toBe("resolved");
  });
});
