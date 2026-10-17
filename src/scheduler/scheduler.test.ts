import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { createFakeProvider } from "../providers/fake.js";
import type { AgentRun, AgentRunOptions, Provider } from "../providers/types.js";
import { RunEmitter } from "../runner/events.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import { InterruptedError, RetriesExhaustedError } from "../state/errors.js";
import { runGraph, type SchedulerEvent } from "./scheduler.js";

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

describe("runGraph through run()", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await tempRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
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
