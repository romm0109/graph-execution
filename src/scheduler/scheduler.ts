import type { Task } from "../graph/task.js";
import { byId } from "../graph/validate.js";

export type SchedulerEvent =
  | { type: "task:start"; task: Task }
  | { type: "task:merged"; task: Task }
  | { type: "task:failed"; task: Task; error: unknown };

export interface SchedulerOptions {
  tasks: Task[];
  /** Ids of dependencies already merged before this run (a resume); they are not in `tasks`. */
  merged?: readonly string[];
  /** Maximum number of tasks running at once (PRD §4, default 3 at the CLI). */
  concurrency: number;
  /** The per-task pipeline: worktree, agent with retries, merge. Resolving means the task is merged. */
  runTask: (task: Task, signal: AbortSignal) => Promise<void>;
  /** Shared by every running task; aborted when one of them fails. Defaults to a fresh controller. */
  controller?: AbortController;
  onEvent?: (event: SchedulerEvent) => void;
}

/**
 * Runs the DAG: a task is ready once all its dependencies are merged, and ready tasks start in id order up to
 * `concurrency`. The first failure stops launching, aborts the shared controller so the other tasks are killed,
 * waits for them to settle and rethrows that failure (PRD §7.7).
 */
export async function runGraph(opts: SchedulerOptions): Promise<void> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${opts.concurrency}`);
  }
  const controller = opts.controller ?? new AbortController();
  const tasksById = new Map(opts.tasks.map((t) => [t.id, t]));
  const pending = new Set([...tasksById.keys()].sort(byId));
  const running = new Map<string, Promise<void>>();
  const merged = new Set<string>(opts.merged);
  const failed = new Set<string>();
  let failure: { error: unknown } | undefined;

  const launch = (task: Task): void => {
    pending.delete(task.id);
    opts.onEvent?.({ type: "task:start", task });
    const settled = Promise.resolve()
      .then(() => opts.runTask(task, controller.signal))
      .then(
        () => {
          merged.add(task.id);
          opts.onEvent?.({ type: "task:merged", task });
        },
        (error: unknown) => {
          failed.add(task.id);
          opts.onEvent?.({ type: "task:failed", task, error });
          failure ??= { error };
          controller.abort();
        },
      )
      .finally(() => running.delete(task.id));
    running.set(task.id, settled);
  };

  for (;;) {
    if (!failure && !controller.signal.aborted) {
      const ready = [...pending].filter((id) => tasksById.get(id)!.dependencies.every((dep) => merged.has(dep)));
      for (const id of ready.slice(0, opts.concurrency - running.size)) launch(tasksById.get(id)!);
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  if (failure) throw failure.error;
  if (controller.signal.aborted) throw controller.signal.reason;
  if (pending.size > 0) {
    throw new Error(`internal error: scheduler stalled with unmerged tasks ${[...pending].join(", ")}`);
  }
}
