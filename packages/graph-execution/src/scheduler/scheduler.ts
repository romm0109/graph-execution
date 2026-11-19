import type { Task } from "../graph/task.js";
import { byId } from "../graph/validate.js";
import { InterruptedError } from "../state/errors.js";

export type SchedulerEvent =
  | { type: "task:start"; task: Task }
  | { type: "task:merged"; task: Task }
  | { type: "task:failed"; task: Task; error: unknown }
  | { type: "task:escalated"; task: Task; error: unknown };

/** What an applied resolution changes in the graph: the new task set, the tasks to run again, the tasks dropped. */
export interface GraphUpdate {
  tasks: Task[];
  requeue: string[];
  removed: string[];
}

export interface SchedulerEscalation {
  /** True for an error that means the task escalated: its branch waits, the run goes on. */
  isEscalation(err: unknown): boolean;
  /** Resolves with the next applied resolution's effect, or undefined when the run is aborted or interrupted. */
  next(): Promise<GraphUpdate | undefined>;
  /** The error thrown when `next()` gives undefined and the shared signal was not aborted; an `InterruptedError` by default. */
  interrupted?: () => unknown;
}

export interface SchedulerOptions {
  tasks: Task[];
  /** Ids of dependencies already merged before this run (a resume); they are not in `tasks`. */
  merged?: readonly string[];
  /** Ids of tasks of `tasks` that escalated before this run (a resume): they wait for a resolution. */
  escalated?: readonly string[];
  /** Maximum number of tasks running at once (PRD §4, default 3 at the CLI). */
  concurrency: number;
  /** The per-task pipeline: worktree, agent with retries, merge. Resolving means the task is merged. */
  runTask: (task: Task, signal: AbortSignal) => Promise<void>;
  /** Shared by every running task; aborted when one of them fails. Defaults to a fresh controller. */
  controller?: AbortController;
  onEvent?: (event: SchedulerEvent) => void;
  /** Escalations pause only their branch of the graph; without this every error is a failure. */
  escalation?: SchedulerEscalation;
}

/**
 * Runs the DAG: a task is ready once all its dependencies are merged, and ready tasks start in id order up to
 * `concurrency`. The first failure stops launching, aborts the shared controller so the other tasks are killed,
 * waits for them to settle and rethrows that failure (PRD §7.7). An escalated task is neither merged nor failed: its
 * dependents are never ready, the rest goes on, and once nothing else can run the scheduler waits for the next
 * resolution (`escalation.next()`), which may change the task set and requeue tasks.
 */
export async function runGraph(opts: SchedulerOptions): Promise<void> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${opts.concurrency}`);
  }
  const controller = opts.controller ?? new AbortController();
  let tasksById = new Map(opts.tasks.map((t) => [t.id, t]));
  const escalated = new Set<string>(opts.escalated?.filter((id) => tasksById.has(id)));
  const pending = new Set([...tasksById.keys()].filter((id) => !escalated.has(id)).sort(byId));
  const running = new Map<string, Promise<void>>();
  const merged = new Set<string>(opts.merged);
  const failed = new Set<string>();
  let failure: { error: unknown } | undefined;
  /** Requeued by a resolution while their escalated run was still settling: they go back to pending, not escalated. */
  const requeueOnSettle = new Set<string>();
  /** The single outstanding `escalation.next()` call, kept across loop iterations. */
  let waiting: Promise<{ update: GraphUpdate | undefined }> | undefined;

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
          if (!failure && !controller.signal.aborted && opts.escalation?.isEscalation(error)) {
            if (requeueOnSettle.delete(task.id)) {
              pending.add(task.id);
              return;
            }
            escalated.add(task.id);
            opts.onEvent?.({ type: "task:escalated", task, error });
            return;
          }
          failed.add(task.id);
          opts.onEvent?.({ type: "task:failed", task, error });
          failure ??= { error };
          controller.abort();
        },
      )
      .finally(() => running.delete(task.id));
    running.set(task.id, settled);
  };

  const abortedSignal = new Promise<"aborted">((resolve) => {
    if (controller.signal.aborted) resolve("aborted");
    else controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const nextUpdate = (): Promise<{ update: GraphUpdate | undefined }> =>
    (waiting ??= opts.escalation!.next().then((update) => ({ update })));

  const apply = (update: GraphUpdate): void => {
    tasksById = new Map(update.tasks.map((t) => [t.id, t]));
    for (const id of update.removed) {
      pending.delete(id);
      escalated.delete(id);
      merged.delete(id);
      failed.delete(id);
    }
    for (const id of update.requeue) {
      escalated.delete(id);
      merged.delete(id);
      failed.delete(id);
      if (!running.has(id)) pending.add(id);
      else requeueOnSettle.add(id);
    }
    // Tasks the resolution added start pending.
    for (const id of tasksById.keys()) {
      if (!pending.has(id) && !running.has(id) && !merged.has(id) && !escalated.has(id) && !failed.has(id)) pending.add(id);
    }
  };

  const ready = (): string[] =>
    [...pending]
      .sort(byId)
      .filter((id) => tasksById.get(id)?.dependencies.every((dep) => merged.has(dep) && !escalated.has(dep)) ?? false);

  for (;;) {
    if (!failure && !controller.signal.aborted) {
      for (const id of ready().slice(0, Math.max(0, opts.concurrency - running.size))) launch(tasksById.get(id)!);
    }
    const waitForDecision = escalated.size > 0 && opts.escalation !== undefined && !failure && !controller.signal.aborted;
    if (running.size === 0 && !waitForDecision) break;
    if (!waitForDecision) {
      await Promise.race(running.values());
      continue;
    }
    // Something escalated: a resolution may arrive while tasks run, or be all there is left to wait for.
    const decision = nextUpdate();
    const winner = await Promise.race<{ update: GraphUpdate | undefined } | "settled" | "aborted">([
      decision,
      abortedSignal,
      ...[...running.values()].map((p) => p.then(() => "settled" as const)),
    ]);
    // Ctrl+C or a failure elsewhere: the loop settles the running tasks and throws.
    if (winner === "settled" || winner === "aborted") continue;
    waiting = undefined;
    if (winner.update === undefined) {
      const reason =
        opts.escalation!.interrupted?.() ??
        new InterruptedError("the run was interrupted while waiting for a decision", { step: "escalation", hint: "resume the run" });
      if (!controller.signal.aborted) controller.abort(reason);
      await Promise.allSettled(running.values());
      throw controller.signal.reason;
    }
    apply(winner.update);
  }

  if (failure) throw failure.error;
  if (controller.signal.aborted) throw controller.signal.reason;
  if (pending.size > 0) {
    throw new Error(`internal error: scheduler stalled with unmerged tasks ${[...pending].join(", ")}`);
  }
}
