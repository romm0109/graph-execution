import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { createFakeProvider } from "../providers/fake.js";
import type { AgentRun, AgentRunOptions, Provider } from "../providers/types.js";
import { RunEmitter } from "../runner/events.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import { InterruptedError, RetriesExhaustedError } from "../state/errors.js";
import { type GraphUpdate, runGraph, type SchedulerEvent } from "./scheduler.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

const task = (id: string, dependencies: string[] = []): Task => ({ id, content: `task ${id}`, dependencies });
const diamond = [task("1"), task("2", ["1"]), task("3", ["1"]), task("4", ["2", "3"])];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Window {
  start: number;
  end: number;
}

/** A fake `runTask` that records each task's start/end time and the peak number of tasks running at once. */
function recorder(durationMs = 20) {
  const windows = new Map<string, Window>();
  let current = 0;
  let peak = 0;
  const runTask = async (t: Task): Promise<void> => {
    const start = performance.now();
    current++;
    peak = Math.max(peak, current);
    await sleep(durationMs);
    current--;
    windows.set(t.id, { start, end: performance.now() });
  };
  return { runTask, windows, peak: () => peak };
}

const overlap = (a: Window, b: Window): boolean => a.start < b.end && b.start < a.end;

describe("runGraph", () => {
  it("runs 2 and 3 of the diamond concurrently and 4 only after both", async () => {
    const { runTask, windows } = recorder();
    const events: string[] = [];
    await runGraph({
      tasks: diamond,
      concurrency: 3,
      runTask,
      onEvent: (e) => events.push(`${e.type} ${e.task.id}`),
    });
    const w = (id: string): Window => windows.get(id)!;
    expect(overlap(w("2"), w("3"))).toBe(true);
    expect(w("2").start).toBeGreaterThanOrEqual(w("1").end);
    expect(w("4").start).toBeGreaterThanOrEqual(Math.max(w("2").end, w("3").end));
    expect(events.slice(0, 4)).toEqual(["task:start 1", "task:merged 1", "task:start 2", "task:start 3"]);
    expect(events.at(-1)).toBe("task:merged 4");
  });

  it("never overlaps tasks with concurrency 1 and starts ready tasks in id order", async () => {
    const { runTask, windows } = recorder(5);
    const tasks = [task("10"), task("2"), task("1"), task("3", ["1"])];
    await runGraph({ tasks, concurrency: 1, runTask });
    const order = [...windows.entries()].sort(([, a], [, b]) => a.start - b.start);
    expect(order.map(([id]) => id)).toEqual(["1", "2", "3", "10"]);
    for (let i = 1; i < order.length; i++) expect(order[i]![1].start).toBeGreaterThanOrEqual(order[i - 1]![1].end);
  });

  it("respects the cap with 5 independent tasks and concurrency 2", async () => {
    const { runTask, windows, peak } = recorder();
    await runGraph({ tasks: ["1", "2", "3", "4", "5"].map((id) => task(id)), concurrency: 2, runTask });
    expect(peak()).toBe(2);
    expect(windows.size).toBe(5);
  });

  it("aborts the other running tasks on a failure, launches nothing more and rethrows it", async () => {
    const exhausted = new RetriesExhaustedError("task 1 failed after 3 attempts", { step: "task 1", hint: "resume" });
    const started: string[] = [];
    const events: SchedulerEvent[] = [];
    const runTask = async (t: Task, signal: AbortSignal): Promise<void> => {
      started.push(t.id);
      if (t.id === "1") {
        await sleep(10);
        throw exhausted;
      }
      // Runs until the shared signal kills it, like a real agent.
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new InterruptedError(`task ${t.id} was interrupted`, { step: `task ${t.id}`, hint: "resume" })));
      });
    };
    const controller = new AbortController();
    const tasks = ["1", "2", "3", "4"].map((id) => task(id));
    await expect(runGraph({ tasks, concurrency: 2, runTask, controller, onEvent: (e) => events.push(e) })).rejects.toBe(exhausted);
    expect(controller.signal.aborted).toBe(true);
    expect(started).toEqual(["1", "2"]);
    expect(events.map((e) => `${e.type} ${e.task.id}`)).toEqual([
      "task:start 1",
      "task:start 2",
      "task:failed 1",
      "task:failed 2",
    ]);
  });

  it("throws the abort reason when the shared signal is aborted before a task starts", async () => {
    const controller = new AbortController();
    const reason = new InterruptedError("the run was interrupted", { step: "run", hint: "resume" });
    controller.abort(reason);
    const { runTask, windows } = recorder();
    await expect(runGraph({ tasks: diamond, concurrency: 3, runTask, controller })).rejects.toBe(reason);
    expect(windows.size).toBe(0);
  });

  it("throws an internal error when no task can ever become ready", async () => {
    const { runTask } = recorder(1);
    await expect(runGraph({ tasks: [task("1"), task("2", ["missing"])], concurrency: 2, runTask })).rejects.toThrow(
      /internal error: scheduler stalled with unmerged tasks 2/,
    );
  });
});

describe("runGraph escalations", () => {
  class Escalated extends Error {}
  const isEscalation = (err: unknown): boolean => err instanceof Escalated;

  /** A `next()` the test answers: `deliver(update)` resolves the pending call. */
  function decisions() {
    let resolve: ((u: GraphUpdate | undefined) => void) | undefined;
    let calls = 0;
    let started!: () => void;
    let waiting = new Promise<void>((r) => (started = r));
    return {
      next: () =>
        new Promise<GraphUpdate | undefined>((r) => {
          calls++;
          resolve = r;
          started();
        }),
      waiting: () => waiting,
      calls: () => calls,
      deliver: (u: GraphUpdate | undefined) => {
        const r = resolve!;
        resolve = undefined;
        waiting = new Promise<void>((res) => (started = res));
        r(u);
      },
    };
  }

  it("keeps independent tasks running and merging and never starts the escalated task's dependents", async () => {
    const d = decisions();
    const events: string[] = [];
    const runTask = async (t: Task): Promise<void> => {
      if (t.id === "2") throw new Escalated("2");
      await sleep(t.id === "3" ? 30 : 5);
    };
    const tasks = [...diamond, task("5"), task("6", ["5"])];
    const done = runGraph({ tasks, concurrency: 3, runTask, escalation: { isEscalation, next: d.next }, onEvent: (e) => events.push(`${e.type} ${e.task.id}`) });
    await d.waiting();
    await vi.waitFor(() => expect(events).toContain("task:merged 6"));
    expect(events).toContain("task:escalated 2");
    expect(events).toContain("task:merged 3");
    expect(events).not.toContain("task:start 4");
    expect(events.some((e) => e.startsWith("task:failed"))).toBe(false);
    // One outstanding next() for the whole wait, however many tasks settled meanwhile.
    expect(d.calls()).toBe(1);
    d.deliver(undefined);
    await expect(done).rejects.toThrow(/interrupted while waiting for a decision/);
  });

  it("waits for both escalations in different branches; a task depending on both needs both requeued", async () => {
    const d = decisions();
    const escalateOnce = new Set(["2", "3"]);
    const started: string[] = [];
    const runTask = async (t: Task): Promise<void> => {
      started.push(t.id);
      if (escalateOnce.delete(t.id)) throw new Escalated(t.id);
    };
    const done = runGraph({ tasks: diamond, concurrency: 3, runTask, escalation: { isEscalation, next: d.next } });
    await vi.waitFor(() => expect(started).toEqual(["1", "2", "3"]));
    await d.waiting();
    d.deliver({ tasks: diamond, requeue: ["2"], removed: [] });
    await vi.waitFor(() => expect(started).toEqual(["1", "2", "3", "2"]));
    await d.waiting();
    expect(started).not.toContain("4");
    d.deliver({ tasks: diamond, requeue: ["3"], removed: [] });
    await done;
    expect(started).toEqual(["1", "2", "3", "2", "3", "4"]);
  });

  it("applies an update: new task set, removed tasks dropped, a merged task reopened", async () => {
    const d = decisions();
    let escalate = true;
    const started: string[] = [];
    const runTask = async (t: Task): Promise<void> => {
      started.push(t.id);
      if (t.id === "2" && escalate) {
        escalate = false;
        throw new Escalated("2");
      }
    };
    const done = runGraph({ tasks: diamond, concurrency: 1, runTask, escalation: { isEscalation, next: d.next } });
    await d.waiting();
    await vi.waitFor(() => expect(started).toEqual(["1", "2", "3"]));
    // Task 4 is removed, task 7 added after 2, and task 1 reopened.
    d.deliver({ tasks: [task("1"), task("2", ["1"]), task("3", ["1"]), task("7", ["2"])], requeue: ["1", "2"], removed: ["4"] });
    await done;
    expect(started).toEqual(["1", "2", "3", "1", "2", "7"]);
  });

  it("throws the abort reason when Ctrl+C comes while only the decision is awaited", async () => {
    const d = decisions();
    const controller = new AbortController();
    const reason = new InterruptedError("the run was interrupted", { step: "run", hint: "resume" });
    const runTask = async (t: Task): Promise<void> => {
      if (t.id === "1") throw new Escalated("1");
    };
    const done = runGraph({ tasks: diamond, concurrency: 2, runTask, controller, escalation: { isEscalation, next: d.next } });
    await d.waiting();
    controller.abort(reason);
    await expect(done).rejects.toBe(reason);
  });

  it("throws the escalation's interrupted error when next() gives undefined", async () => {
    const reason = new InterruptedError("waiting for a decision", { step: "escalation", hint: "resume" });
    const runTask = async (t: Task): Promise<void> => {
      if (t.id === "1") throw new Escalated("1");
    };
    await expect(
      runGraph({ tasks: diamond, concurrency: 2, runTask, escalation: { isEscalation, next: async () => undefined, interrupted: () => reason } }),
    ).rejects.toBe(reason);
  });

  it("treats an escalation as a failure when no escalation option is given", async () => {
    const err = new Escalated("1");
    const runTask = async (t: Task): Promise<void> => {
      if (t.id === "1") throw err;
    };
    await expect(runGraph({ tasks: diamond, concurrency: 2, runTask })).rejects.toBe(err);
  });
});

describe("runGraph through run()", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await tempRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("runs 2 and 3 in parallel worktrees and cuts task 4's worktree after both merged", async () => {
    const provider = createFakeProvider();
    const merged: string[] = [];
    const timeline: string[] = [];
    let task4Files: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const waiting = new Set(["2", "3"]);

    // Tasks 2 and 3 wait for each other before their agents run: this only completes if they run at the same time.
    const parallel: Provider = {
      name: provider.name,
      run(opts: AgentRunOptions): AgentRun {
        timeline.push(`start ${opts.label}`);
        if (opts.label === "4") {
          task4Files = ["1.txt", "2.txt", "3.txt"].filter((f) => existsSync(path.join(opts.cwd, f)));
        }
        if (!waiting.has(opts.label)) return provider.run(opts);
        waiting.delete(opts.label);
        if (waiting.size === 0) release();
        const inner = bothStarted.then(() => provider.run(opts));
        return {
          events: (async function* () {
            yield* (await inner).events;
          })(),
          done: inner.then((r) => r.done),
        };
      },
    };

    const events = new RunEmitter();
    events.on("task:merged", ({ taskId }) => {
      merged.push(taskId);
      timeline.push(`merged ${taskId}`);
    });
    const tasks = await loadTasks(fixture("diamond"));
    const log = (): void => {};
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: parallel, log });
    const result = await run(ctx, tasks, { specPath: fixture("spec.md"), tasksDir: "tasks", log, concurrency: 3, events });
    expect(result.exitCode).toBe(0);

    expect(task4Files).toEqual(["1.txt", "2.txt", "3.txt"]);
    expect(timeline.indexOf("start 4")).toBeGreaterThan(Math.max(timeline.indexOf("merged 2"), timeline.indexOf("merged 3")));
    expect(timeline.indexOf("start 3")).toBeLessThan(Math.min(timeline.indexOf("merged 2"), timeline.indexOf("merged 3")));
    expect(provider.calls.map((c) => path.basename(c.cwd)).sort()).toEqual([
      "review-code-r0",
      "review-tester-r0",
      "task-1-a1",
      "task-2-a1",
      "task-3-a1",
      "task-4-a1",
    ]);
    expect(merged.slice(0, 1)).toEqual(["1"]);
    expect(merged.at(-1)).toBe("4");

    // Serialized merges: every first-parent step on the integration branch is one merge commit, one per task.
    const branch = `graph/${ctx.runId}`;
    const firstParent = (await gitOut(repo, ["rev-list", "--first-parent", `${ctx.startingCommit}..${branch}`])).split("\n");
    const merges = (await gitOut(repo, ["rev-list", "--first-parent", "--merges", `${ctx.startingCommit}..${branch}`])).split("\n");
    expect(firstParent).toHaveLength(4);
    expect(merges).toEqual(firstParent);
  });
});
