import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { resolveConflicts } from "../agents/resolver.js";
import { type AttemptFailure, type CheckResult, withRetries } from "../agents/retry.js";
import { taskPrompt, validationFixPrompt } from "../agents/task.js";
import {
  addWorktree,
  commitLines,
  createBranch,
  currentHead,
  hasNewCommit,
  merge,
  applyToCheckout,
  commitLeftovers,
  dirtyPaths,
  pruneWorktrees,
  removeWorktreeIfPresent,
  resetHard,
} from "../git/git.js";
import { createMergeLock } from "../git/mutex.js";
import { CONFIG_FILE } from "../config/config.js";
import { executionLayers } from "../graph/validate.js";
import type { AgentEvent, AgentRun, Provider } from "../providers/types.js";
import type { Task } from "../graph/task.js";
import { runGraph } from "../scheduler/scheduler.js";
import {
  AbortRunError,
  EXIT_ABORT,
  EXIT_REVIEW_FAILED,
  EXIT_SUCCESS,
  type ExitCode,
  exitCodeFor,
  InterruptedError,
} from "../state/errors.js";
import { codeReviewSkipped, NOT_PERFORMED, readReport, runReviewPhase } from "../review/phase.js";
import type { Report } from "../review/report.js";
import { reconcile } from "../state/resume.js";
import {
  acquireLock,
  computeHashes,
  initialReviewState,
  StateStore,
} from "../state/state.js";
import type { UiHandle, UiOptions } from "../ui/start.js";
import { failedNodeIds, logFileName, RunStore, writeAgentLogs } from "../ui/store.js";
import { runCommands, writeValidationLog } from "../validate/commands.js";
import { reviewReportPath } from "../agents/reviewer.js";
import { abortRun, resumeCommand } from "./abort.js";
import { startFailureSummaries } from "./failure-summary.js";
import { ChangeTracker } from "./changes.js";
import { RunEmitter, type TargetMerge } from "./events.js";
import { AGENT_NODE, GATE_NODE, MERGE_NODE } from "./nodes.js";
import type { RetryHub } from "./retry-hub.js";
import { snapshotReferences } from "./references.js";
import { preflight } from "../launch/preflight.js";
import type { RunContext } from "./startup.js";

export interface RunGraphOptions {
  specPath: string;
  /** The tasks folder; the reviewers are told where it is (PRD §7.5). */
  tasksDir: string;
  model?: string;
  /** Maximum tasks running at once (PRD §4); overrides `config.concurrency`. */
  concurrency?: number;
  /** Receives the scheduler events; a fresh emitter is used when omitted. */
  events?: RunEmitter;
  /** Aborting it interrupts the run like Ctrl+C. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Starts the terminal UI (`startUi`) before the scheduler; its `log` replaces `log`. */
  ui?: (opts: UiOptions) => UiHandle | Promise<UiHandle>;
  /** Keeps the process alive after a failure so a node can be retried in place; see `RetryHub`. */
  retry?: RetryHub;
  /** False keeps the result on `graph/<run-id>` only, instead of merging it into the starting branch. */
  merge?: boolean;
}

/** How one pass over the graph ended; `error` is what aborted it. */
interface PassOutcome {
  exitCode: ExitCode;
  error?: unknown;
  merge?: TargetMerge;
}

const NODE_TITLE: Record<string, string> = {
  [GATE_NODE]: "validation gate",
  [AGENT_NODE.gateFixer]: "validation fixer",
  [AGENT_NODE.reviewer]: "code reviewer",
  [AGENT_NODE.tester]: "live tester",
  [AGENT_NODE.fixer]: "fixer",
};

export interface RunResult {
  exitCode: ExitCode;
  state: StateStore;
}

export const integrationBranchName = (runId: string): string => `graph/${runId}`;
/** Not `graph/<run-id>/...`: git cannot hold both refs `graph/x` and `graph/x/y`. */
export const taskBranchName = (runId: string, taskId: string): string => `graph-task/${runId}/${taskId}`;

export const DEFAULT_CONCURRENCY = 3;

/** How a run ends (PRD §7.11). */
export type Outcome = "success" | "exhausted" | "aborted";

const EXIT_CODES: Record<Outcome, ExitCode> = {
  success: EXIT_SUCCESS,
  exhausted: EXIT_REVIEW_FAILED,
  aborted: EXIT_ABORT,
};

/**
 * End of run (PRD §7.11): on success every worktree of the run is removed, the integration worktree included, leaving
 * only the branch `graph/<run-id>` and the run directory (state, logs, reports). An exhausted review loop (exit 1) and
 * an abort (exit 2) remove nothing, so the run can be inspected or resumed.
 */
export async function finish(outcome: Outcome, ctx: { repo: string; runDir: string }): Promise<ExitCode> {
  if (outcome === "success") {
    const worktreesDir = path.join(ctx.runDir, "worktrees");
    await pruneWorktrees(ctx.repo);
    const entries = existsSync(worktreesDir) ? await readdir(worktreesDir) : [];
    for (const name of entries) await removeWorktreeIfPresent(ctx.repo, path.join(worktreesDir, name));
    await rm(worktreesDir, { recursive: true, force: true });
  }
  return EXIT_CODES[outcome];
}

/**
 * Executes the task graph with up to `concurrency` tasks at once: each task gets its own branch and worktree cut
 * from the integration HEAD when it starts (and runs the `setup` commands), must produce a commit within 3 attempts,
 * then passes the validation gate (failures go back to the agent for up to 3 fix rounds), and is merged with `--no-ff`
 * into the integration worktree behind the merge lock, where conflicts go to the resolver agent. Exhausted attempts and
 * Ctrl+C both end in `abortRun` with exit code 2, after the other running agents were killed. Once every task is
 * merged, the review phase runs (PRD §7.5) and decides the outcome, which `finish` turns into the exit code. The run
 * holds the run directory's PID lock.
 */
export async function run(ctx: RunContext, tasks: Task[], opts: RunGraphOptions): Promise<RunResult> {
  const release = await acquireLock(ctx.runDir);
  try {
    const integrationBranch = integrationBranchName(ctx.runId);
    // The hashes are taken once, here, and checked by every resume (PRD §7.8).
    const hashes = await computeHashes(path.join(ctx.repo, CONFIG_FILE), opts.tasksDir, opts.specPath);
    const store = new StateStore(path.join(ctx.runDir, "state.json"), {
      runId: ctx.runId,
      provider: ctx.provider.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      startingCommit: ctx.startingCommit,
      integrationBranch,
      ...(opts.merge !== false && ctx.startBranch ? { targetBranch: ctx.startBranch } : {}),
      specPath: path.resolve(opts.specPath),
      tasksDir: path.resolve(opts.tasksDir),
      hashes,
      tasks: Object.fromEntries(tasks.map((t) => [t.id, { status: "pending", attempts: 0 }])),
      review: initialReviewState(),
      createdAt: new Date().toISOString(),
    });
    // The branch exists before the first save, so every saved state has it; resume re-adds a missing worktree.
    await createBranch(ctx.repo, ctx.startingCommit, integrationBranch);
    await store.save();
    await addWorktree(ctx.repo, path.join(ctx.runDir, "worktrees", "integration"), integrationBranch);
    return await execute(ctx, tasks, store, opts);
  } finally {
    await release();
  }
}

export interface ResumeOptions {
  cwd: string;
  /** The run to resume; the latest one when omitted. */
  runId?: string;
  /** Overrides provider lookup (tests inject a fake provider instance). */
  providerInstance?: Provider;
  events?: RunEmitter;
  signal?: AbortSignal;
  log?: (line: string) => void;
  ui?: (opts: UiOptions) => UiHandle | Promise<UiHandle>;
  retry?: RetryHub;
  /** False skips the final merge into the starting branch for this resume. */
  merge?: boolean;
}

/**
 * `--resume` (PRD §7.8): loads the run's state, refuses when the config, the task folder or the spec changed since
 * the run started, takes the PID lock, reconciles the state with git (git wins) and continues: the tasks not merged
 * yet go through the scheduler, then the review phase picks up at its saved round and step. The starting commit and
 * the integration branch come from the state and are never recreated.
 */
export async function resume(opts: ResumeOptions): Promise<RunResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const pre = await preflight({ cwd: opts.cwd, resume: true, runId: opts.runId, providerInstance: opts.providerInstance });
  if (pre.kind !== "resume") throw new Error("unreachable");
  const { repo, runDir, store, tasks } = pre;
  const { state } = store;

  const release = await acquireLock(runDir);
  try {
    const ctx: RunContext = {
      repo,
      runId: state.runId,
      runDir,
      startingCommit: state.startingCommit,
      provider: pre.provider,
      config: pre.config,
    };
    log(`resuming run ${state.runId} on ${state.integrationBranch}`);
    await reconcile(state, repo);
    await store.save();
    return await execute(ctx, tasks, store, {
      specPath: state.specPath,
      tasksDir: state.tasksDir,
      model: state.model,
      concurrency: state.concurrency,
      events: opts.events,
      signal: opts.signal,
      log,
      ui: opts.ui,
      retry: opts.retry,
      merge: opts.merge,
    });
  } finally {
    await release();
  }
}

/**
 * Runs the tasks of `store` that are not merged yet, then the review phase from its saved step. Merged tasks count as
 * done for the ready set; a `merging` task only has its merge (re)done.
 */
async function execute(ctx: RunContext, tasks: Task[], store: StateStore, opts: RunGraphOptions): Promise<RunResult> {
  const config = ctx.config;
  const worktreesDir = path.join(ctx.runDir, "worktrees");
  const integrationWorktree = path.join(worktreesDir, "integration");
  const integrationBranch = integrationBranchName(ctx.runId);
  const events = opts.events ?? new RunEmitter();
  /** Serializes merges and every other git operation on the integration worktree or the worktree list. */
  const withMergeLock = createMergeLock();
  const provider = teeOutput(ctx.provider, events);
  const references = await snapshotReferences(ctx.repo, ctx.runDir, opts.specPath, opts.tasksDir);
  const mergeTarget = opts.merge === false ? undefined : store.state.targetBranch;
  const nodeTitle = (id: string): string =>
    id === MERGE_NODE ? (mergeTarget ? `apply to ${mergeTarget}` : "result branch") : (NODE_TITLE[id] ?? `task ${id}`);
  const mergedIds = (): string[] => tasks.filter((t) => store.state.tasks[t.id]!.status === "merged").map((t) => t.id);

  // Every agent's full output is kept in logs/<label>.log, whatever the UI shows (PRD §7.9).
  const logsDir = path.join(ctx.runDir, "logs");
  const stopLogs = writeAgentLogs(events, logsDir);
  const view = new RunStore(events, { taskIds: tasks.map((t) => t.id), merged: mergedIds(), attempts: config.attempts });
  const changes = new ChangeTracker(events);
  // After a resume, merged tasks show their stats again from git history.
  for (const id of mergedIds()) {
    const { baseSha, branch } = store.state.tasks[id]!;
    if (baseSha && branch) void changes.seed(id, ctx.repo, baseSha, branch).catch(() => undefined);
  }
  // The fixers' pass ranges are persisted, so their diffs survive a resume.
  const fixNodes = new Set<string>([AGENT_NODE.fixer, AGENT_NODE.gateFixer]);
  const stopFixRanges = [
    events.on("changes:track", ({ nodeId, base }) => {
      if (!fixNodes.has(nodeId)) return;
      void store.update((s) => {
        (s.fixRanges ??= {})[nodeId] = { from: base };
      });
    }),
    events.on("changes:stop", ({ nodeId, to }) => {
      if (!fixNodes.has(nodeId) || !to) return;
      void store.update((s) => {
        const range = s.fixRanges?.[nodeId];
        if (range) range.to = to;
      });
    }),
  ];
  for (const [id, range] of Object.entries(store.state.fixRanges ?? {})) {
    if (range.to) void changes.seed(id, ctx.repo, range.from, range.to).catch(() => undefined);
  }
  let controller = new AbortController();
  let last: PassOutcome;
  let log = opts.log ?? ((line: string) => console.log(line));
  const summaries = startFailureSummaries({
    events,
    view,
    provider,
    model: opts.model,
    runDir: ctx.runDir,
    logsDir,
    log: (line) => log(line),
    title: nodeTitle,
    taskContent: (nodeId) => tasks.find((t) => t.id === nodeId)?.content,
  });
  // The last review round's reports, for the summary of a run that aborts later.
  let lastReports: Report[] = [];
  const stopReports = events.on("review:end", ({ reports }) => (lastReports = reports));
  let ui: UiHandle | undefined;
  /** Per worktree, what was already dirty when its agent started (setup or validation output), for `checkAgent`. */
  const dirtyAtStart = new Map<string, string[]>();

  const runEnd = (exitCode: number, reports: Report[], err?: unknown, merge?: TargetMerge): void =>
    events.emit("run:end", {
      ...(merge ? { merge } : {}),
      runId: ctx.runId,
      branch: integrationBranch,
      exitCode,
      reports,
      fixPasses: config.fixPasses,
      runDir: ctx.runDir,
      ...(err === undefined
        ? {}
        : {
            abort: {
              step: err instanceof AbortRunError ? err.step : "run",
              message: err instanceof Error ? err.message : String(err),
              hint: err instanceof AbortRunError ? err.hint : resumeCommand(ctx.runId),
            },
          }),
    });

  try {
    ui = await opts.ui?.({
      events,
      changes,
      layers: executionLayers(tasks).map((layer) => layer.map((t) => t.id)),
      parents: Object.fromEntries(tasks.map((t) => [t.id, t.dependencies])),
      ...(mergeTarget ? { mergeTarget } : {}),
      merged: mergedIds(),
      attempts: config.attempts,
      runId: ctx.runId,
      provider: ctx.provider.name,
      logsDir,
      store: view,
      ...(opts.retry ? { retry: opts.retry } : {}),
      runDir: ctx.runDir,
    });
    if (ui) log = ui.log;

    for (;;) {
      last = await pass();
      const nodes = opts.retry && !(last.error instanceof InterruptedError) ? await retryTargets(last) : [];
      if (!opts.retry || nodes.length === 0) break;
      const hub = opts.retry;
      // Merging what was done so far is offered when the result can still go to the starting branch.
      const canMerge = mergeTarget !== undefined && last.merge === undefined;
      events.emit("retry:available", { nodes, merge: canMerge });
      const quit = (): void => hub.quit();
      process.on("SIGINT", quit);
      process.on("SIGTERM", quit);
      opts.signal?.addEventListener("abort", quit, { once: true });
      if (opts.signal?.aborted) quit();
      let id: string | undefined;
      let merged = false;
      try {
        for (;;) {
          const choice = await hub.wait(nodes, canMerge);
          if (choice && "merge" in choice) {
            events.emit("retry:available", { nodes: [], merge: false });
            const outcome = await mergeUnfinished(last);
            if (outcome.merge?.ok) {
              last = outcome;
              merged = true;
              break;
            }
            // Not applied (the reason is in the summary): the choice stays open.
            events.emit("retry:available", { nodes, merge: canMerge });
            continue;
          }
          id = choice?.retry;
          break;
        }
      } finally {
        process.off("SIGINT", quit);
        process.off("SIGTERM", quit);
        opts.signal?.removeEventListener("abort", quit);
      }
      if (merged || id === undefined) {
        events.emit("retry:available", { nodes: [] });
        break;
      }
      await prepareRetry(id);
      log(`retrying ${nodeTitle(id)}`);
      events.emit("run:restart", { nodeId: id });
    }
    // Failure summaries still under way finish first, so the final output has them.
    await summaries.drain();
    // The terminal is restored before the abort message, so the shell is usable and the message readable.
    await ui?.stop();
    if (last.error !== undefined) {
      await abortRun(last.error, { store, log });
      return { exitCode: await finish("aborted", ctx), state: store };
    }
    return { exitCode: last.exitCode as ExitCode, state: store };
  } finally {
    await ui?.stop();
    summaries.stop();
    view.dispose();
    stopReports();
    for (const off of stopFixRanges) off();
    changes.dispose();
    stopLogs();
  }

  /** One run of the graph and the review phase; never throws, an error ends it as `{ error }`. */
  async function pass(): Promise<PassOutcome> {
    const merged = mergedIds();
    const remaining = tasks.filter((t) => !merged.includes(t.id));
    controller = new AbortController();
    const mine = controller;
    const abort = (): void =>
      mine.abort(new InterruptedError("the run was interrupted", { step: "run", hint: resumeCommand(ctx.runId) }));
    // The single Ctrl+C / SIGTERM handler: aborting the shared signal kills running agents (PRD §7.7).
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    try {
      events.emit("phase:change", { phase: "tasks" });
      await runGraph({
        tasks: remaining,
        merged,
        concurrency: opts.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY,
        controller: mine,
        runTask,
        onEvent: (event) => {
          const taskId = event.task.id;
          if (event.type === "task:start") events.emit("task:start", { taskId });
          else if (event.type === "task:merged") {
            events.emit("task:merged", { taskId, mergeCommit: store.state.tasks[taskId]!.mergeCommit! });
          } else events.emit("task:failed", { taskId, error: event.error });
        },
      });
      log(`all ${tasks.length} task(s) merged into ${integrationBranch}`);
      const review = await runReviewPhase({
        provider,
        config,
        repo: ctx.repo,
        runDir: ctx.runDir,
        integrationWorktree,
        integrationBranch,
        startingCommit: ctx.startingCommit,
        specPath: opts.specPath,
        tasksDir: opts.tasksDir,
        signal: mine.signal,
        hint: resumeCommand(ctx.runId),
        model: opts.model,
        log,
        withLock: withMergeLock,
        events,
        progress: store.state.review,
        onProgress: (progress) =>
          store.update((s) => {
            s.review = structuredClone(progress);
          }),
      });
      const exitCode = await withMergeLock(() =>
        finish(review.exitCode === EXIT_SUCCESS ? "success" : "exhausted", ctx),
      );
      if (exitCode === EXIT_SUCCESS) log(`worktrees removed; the result is on ${integrationBranch}`);
      const merge =
        exitCode === EXIT_SUCCESS && mergeTarget
          ? await mergeResult(mergeTarget, codeReviewSkipped(review.reports))
          : undefined;
      if (!merge) events.emit("merge:status", { status: "skipped" });
      runEnd(exitCode, review.reports, undefined, merge);
      return { exitCode, ...(merge ? { merge } : {}) };
    } catch (err) {
      runEnd(exitCodeFor(err), lastReports, err);
      await store.save();
      return { exitCode: exitCodeFor(err), error: err };
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  /** The failed nodes a retry can fix, given where the review phase stopped. */
  async function retryTargets(outcome: PassOutcome): Promise<string[]> {
    const { review } = store.state;
    const targets: string[] = [];
    for (const id of failedNodeIds(view.getState())) {
      const kind = id === AGENT_NODE.reviewer ? "code" : id === AGENT_NODE.tester ? "tester" : undefined;
      if (kind) {
        // After the result was applied to the starting branch, a second apply would conflict.
        if (outcome.merge?.ok) continue;
        if (review.phase !== "review" && review.phase !== "done") continue;
        // Only a reviewer that gave up (or left no report) is retried; a valid report is the reviewer's answer.
        const report = await readReport(reviewReportPath(ctx.runDir, review.round, kind), review.round, kind);
        if (report && !(report.notes ?? []).some((n) => n.startsWith(NOT_PERFORMED[kind]))) continue;
      } else if (id === GATE_NODE || id === AGENT_NODE.gateFixer) {
        if (review.phase !== "validate") continue;
      } else if (id === AGENT_NODE.fixer) {
        if (review.phase !== "fix") continue;
      }
      targets.push(id);
    }
    return targets;
  }

  /**
   * The user chose to take the run's result as it is after a failure: applies `graph/<run-id>` (the tasks merged so
   * far and any fixes) to the starting branch like a clean run's last step, and shows it in the final summary. The
   * run keeps its failure exit code and its worktrees, so it can still be resumed.
   */
  async function mergeUnfinished(outcome: PassOutcome): Promise<PassOutcome> {
    const merge = await withMergeLock(() => mergeResult(mergeTarget!, false));
    runEnd(outcome.exitCode, lastReports, outcome.error, merge);
    return { ...outcome, merge };
  }

  /** Brings the state back in line with git and resets the budget of the retried node, as `--resume` would. */
  async function prepareRetry(nodeId: string): Promise<void> {
    await reconcile(store.state, ctx.repo);
    const { review } = store.state;
    if (nodeId === GATE_NODE || nodeId === AGENT_NODE.gateFixer || nodeId === AGENT_NODE.fixer) {
      review.validationRounds = 0;
    } else if (nodeId === AGENT_NODE.reviewer || nodeId === AGENT_NODE.tester) {
      const kind = nodeId === AGENT_NODE.reviewer ? "code" : "tester";
      await rm(reviewReportPath(ctx.runDir, review.round, kind), { force: true });
      const reports = { ...review.reports };
      delete reports[kind];
      store.state.review = { phase: "review", round: review.round, validationRounds: 0, reports };
    }
    await store.save();
  }

  /**
   * The final step of a clean run: applies `graph/<run-id>` to the branch the run started from, in the user's own
   * checkout, as uncommitted changes, and collects them for the summary. Not done when the code review was not
   * performed: an unreviewed result stays on its branch for the user to look at first.
   */
  async function mergeResult(target: string, unreviewed: boolean): Promise<TargetMerge> {
    const none = { target, files: [], commits: [] };
    if (unreviewed) {
      events.emit("merge:status", { status: "skipped" });
      log(`not applying to ${target}: the code review was not performed`);
      return { ...none, ok: false, reason: "the code review was not performed; look at the branch before merging it" };
    }
    events.emit("merge:status", { status: "running" });
    log(`applying ${integrationBranch} to ${target} as uncommitted changes`);
    const commits = await commitLines(ctx.repo, "HEAD", integrationBranch);
    const result = await applyToCheckout(ctx.repo, target, integrationBranch);
    if (!result.ok) {
      events.emit("merge:status", { status: "failed" });
      log(`not applied to ${target}: ${result.reason}`);
      return { ...none, ok: false, reason: result.reason };
    }
    events.emit("merge:status", { status: "done" });
    const conflicted = result.conflicts.length > 0 ? `, ${result.conflicts.length} with conflicts to resolve` : "";
    const kept = result.backup ? "; your uncommitted changes were kept and merged in (backup in git stash list)" : "";
    log(`applied to ${target}: ${result.files.length} file(s) changed${conflicted}, nothing committed${kept}`);
    return { ...none, ok: true, files: result.files, conflicts: result.conflicts, backup: result.backup, commits };
  }

  async function runTask(task: Task): Promise<void> {
    try {
      // A resumed `merging` task already passed its gates: only the merge is left.
      if (store.state.tasks[task.id]!.status === "merging") {
        events.emit("task:status", { taskId: task.id, status: "merging" });
        await mergeTask(task);
      } else await attemptAndMerge(task);
    } catch (err) {
      // An interrupted task keeps its `running` status; resume reconciles it (PRD §7.8).
      if (!(err instanceof InterruptedError)) {
        await store.update((s) => {
          s.tasks[task.id]!.status = "failed";
        });
        // Keep the last attempt's diff viewable after its worktree is cleaned up.
        const branch = store.state.tasks[task.id]!.branch;
        if (branch) events.emit("changes:stop", { nodeId: task.id, repo: ctx.repo, to: branch });
      }
      throw err;
    }
  }

  async function attemptAndMerge(task: Task): Promise<void> {
    const signal = controller.signal;
    const step = `task ${task.id}`;
    if (signal.aborted) throw new InterruptedError(`${step} was interrupted`, { step, hint: resumeCommand(ctx.runId) });

    const branch = taskBranchName(ctx.runId, task.id);
    /**
     * Attempts used up before a resume (PRD §7.8): a task killed during attempt N redoes attempt N, so N - 1 attempts
     * are spent and only the rest of the budget is left. A fresh or failed task starts at 0.
     */
    const priorAttempts = Math.max(0, store.state.tasks[task.id]!.attempts - 1);
    const worktreeFor = (attempt: number): string =>
      path.join(worktreesDir, `task-${task.id}-a${priorAttempts + attempt}`);
    let base = "";
    let previousFailure: AttemptFailure | undefined;

    await withRetries({
      attempts: Math.max(1, config.attempts - priorAttempts),
      label: step,
      hint: resumeCommand(ctx.runId),
      signal,
      onAttempt: async (attempt, previous) => {
        previousFailure = previous;
        if (previous) {
          events.emit("changes:reset", { nodeId: task.id });
          log(`task ${task.id}: ${previous.message}; retry ${priorAttempts + attempt}/${config.attempts}`);
          events.emit("task:retry", {
            taskId: task.id,
            attempt: priorAttempts + attempt,
            attempts: config.attempts,
            reason: previous,
          });
        } else log(`task ${task.id}: running`);
        await store.update((s) => {
          Object.assign(s.tasks[task.id]!, {
            status: "running",
            attempts: priorAttempts + attempt,
            branch,
            worktree: worktreeFor(attempt),
          });
        });
      },
      prepare: async (attempt) => {
        await withMergeLock(async () => {
          // A retry starts from a fresh worktree: drop the previous attempt's and cut the branch again.
          if (attempt > 1) await removeWorktreeIfPresent(ctx.repo, worktreeFor(attempt - 1));
          await removeWorktreeIfPresent(ctx.repo, worktreeFor(attempt));
          // Cut from the integration HEAD now, so the task sees everything merged before it started (PRD story 3).
          base = await currentHead(integrationWorktree);
          await addWorktree(ctx.repo, worktreeFor(attempt), branch, base);
        });
        await store.update((s) => {
          s.tasks[task.id]!.baseSha = base;
        });
        await runSetup(task, worktreeFor(attempt), signal);
      },
      execute: (attempt) =>
        runAgent(task, taskPrompt(task, { references, previous: previousFailure }), worktreeFor(attempt), base, signal),
      check: (exitCode, attempt) => checkAgent(task, exitCode, worktreeFor(attempt), base),
    });

    await validate(task, store.state.tasks[task.id]!.worktree!, signal);
    await store.update((s) => {
      s.tasks[task.id]!.status = "merging";
    });
    events.emit("task:status", { taskId: task.id, status: "merging" });
    await mergeTask(task);
  }

  /** Merges the task's branch into the integration worktree behind the merge lock, then drops its worktree. */
  async function mergeTask(task: Task): Promise<void> {
    const signal = controller.signal;
    const step = `task ${task.id}`;
    const branch = store.state.tasks[task.id]!.branch ?? taskBranchName(ctx.runId, task.id);
    const worktree = store.state.tasks[task.id]!.worktree;
    await withMergeLock(async () => {
      const message = `Merge task ${task.id}`;
      const result = await merge(integrationWorktree, branch, message);
      // Conflicts go to the resolver agent (PRD §7.3) inside this same critical section.
      const mergeCommit = result.ok
        ? await currentHead(integrationWorktree)
        : await resolveConflicts({
            provider,
            integrationWorktree,
            branch,
            files: result.conflicted,
            message,
            label: task.id,
            step,
            hint: resumeCommand(ctx.runId),
            signal,
            attempts: config.attempts,
            model: opts.model,
            log,
          });
      await store.update((s) => {
        Object.assign(s.tasks[task.id]!, { status: "merged", mergeCommit });
      });
      // The branch outlives the worktree: the finished task's diff comes from git history.
      events.emit("changes:stop", { nodeId: task.id, repo: ctx.repo, to: branch });
      // The task is merged: a worktree git cannot remove (e.g. a path too long for Windows) must not fail it.
      if (worktree) await removeWorktreeIfPresent(ctx.repo, worktree);
    });
    if (worktree) {
      await store.update((s) => {
        delete s.tasks[task.id]!.worktree;
      });
    }
    log(`task ${task.id}: merged`);
  }

  async function runAgent(task: Task, prompt: string, cwd: string, base: string, signal: AbortSignal): Promise<number> {
    dirtyAtStart.set(cwd, await dirtyPaths(cwd));
    events.emit("changes:track", { nodeId: task.id, worktree: cwd, base, exclude: dirtyAtStart.get(cwd) });
    const agent = provider.run({ role: "task", prompt, cwd, signal, model: opts.model, label: task.id });
    const forward = async (): Promise<void> => {
      for await (const event of agent.events) {
        if (event.type === "output") log(`[${task.id}] ${event.text.trimEnd()}`);
      }
    };
    try {
      const [, { exitCode }] = await Promise.all([forward(), agent.done]);
      return exitCode;
    } finally {
      events.emit("changes:stop", { nodeId: task.id });
    }
  }

  /**
   * A task agent succeeds only with a clean exit and a new commit on top of `base`. What a cleanly finished agent left
   * uncommitted is committed for it first, so only an agent that produced nothing at all fails with `no_commit`.
   */
  async function checkAgent(task: Task, exitCode: number, cwd: string, base: string): Promise<CheckResult<undefined>> {
    if (exitCode !== 0) return { ok: false, reason: { class: "crash", message: `agent exited with code ${exitCode}` } };
    if (await commitLeftovers(cwd, `Task ${task.id}: changes the agent left uncommitted`, dirtyAtStart.get(cwd))) {
      log(`task ${task.id}: committed changes the agent left uncommitted`);
    }
    if (!(await hasNewCommit(cwd, base))) {
      return { ok: false, reason: { class: "no_commit", message: "the agent made no commit" } };
    }
    return { ok: true, value: undefined };
  }

  const interrupted = (step: string): InterruptedError =>
    new InterruptedError(`${step} was interrupted`, { step, hint: resumeCommand(ctx.runId) });

  /** Runs the config's `setup` commands once in a new task worktree, before the agent starts (PRD §9). */
  async function runSetup(task: Task, worktree: string, signal: AbortSignal): Promise<void> {
    if (config.setup.length === 0) return;
    const step = `task ${task.id}`;
    log(`task ${task.id}: running setup`);
    const result = await runCommands(config.setup, worktree, signal);
    if (signal.aborted) throw interrupted(step);
    if (!result.ok) {
      log(result.output);
      throw new AbortRunError(`setup command \`${result.command}\` failed with exit code ${result.exitCode}`, {
        step,
        hint: resumeCommand(ctx.runId),
      });
    }
  }

  /**
   * The validation gate (PRD §7.4): runs the task's commands (its override, else `config.validate`) in its worktree.
   * Failing output goes back to the task agent for up to `validationRounds` fix rounds; each fix round has its own
   * retries, separate from the task's attempts. With `validateAt: "end"` no task is validated on its own.
   */
  async function validate(task: Task, worktree: string, signal: AbortSignal): Promise<void> {
    if (config.validateAt === "end") return;
    const commands = task.validate === false ? [] : (task.validate ?? config.validate);
    if (commands.length === 0) return;
    const step = `task ${task.id}`;
    const hint = resumeCommand(ctx.runId);
    await store.update((s) => {
      s.tasks[task.id]!.status = "validating";
    });
    events.emit("task:status", { taskId: task.id, status: "validating" });

    const rounds = config.validationRounds;
    for (let round = 1; ; round++) {
      log(round === 1 ? `task ${task.id}: validating` : `task ${task.id}: validating again after fix round ${round - 1}/${rounds}`);
      const result = await runCommands(commands, worktree, signal, { parallel: config.validateParallel });
      if (signal.aborted) throw interrupted(step);
      if (result.ok) {
        if (round > 1) log(`task ${task.id}: validation passed after ${round - 1} fix round(s)`);
        return;
      }
      const failure = `\`${result.command}\` failed with exit code ${result.exitCode}`;
      const where = await writeValidationLog(logsDir, `${logFileName(task.id).replace(/\.log$/, "")}-validate-${round}`, result);
      log(`task ${task.id}: validation failed: ${where}`);
      if (round > rounds) {
        throw new AbortRunError(`validation failed after ${rounds} rounds: ${failure}`, { step, hint });
      }
      log(`task ${task.id}: sent back to the agent to fix it (fix round ${round}/${rounds})`);
      events.emit("task:status", { taskId: task.id, status: "fixing", round, rounds });

      let before = "";
      await withRetries({
        attempts: config.attempts,
        label: `${step} fix round ${round}`,
        hint,
        signal,
        onAttempt: (attempt, previous) => {
          if (previous) log(`task ${task.id}: ${previous.message}; fix round ${round} retry ${attempt}/${config.attempts}`);
        },
        // Fix rounds stay in the task's worktree; a retry drops whatever the failed fix attempt left behind.
        prepare: async (attempt) => {
          if (attempt === 1) before = await currentHead(worktree);
          else await resetHard(worktree, before);
        },
        execute: () => runAgent(task, validationFixPrompt(task, result, references), worktree, store.state.tasks[task.id]!.baseSha ?? before, signal),
        check: (exitCode) => checkAgent(task, exitCode, worktree, before),
      });
      events.emit("task:status", { taskId: task.id, status: "validating", round, rounds });
    }
  }
}

/** Wraps `provider` so every agent's output is also emitted as an `output` event under the agent's label. */
function teeOutput(provider: Provider, events: RunEmitter): Provider {
  return {
    name: provider.name,
    run(opts): AgentRun {
      const agent = provider.run(opts);
      async function* tee(): AsyncGenerator<AgentEvent> {
        for await (const event of agent.events) {
          if (event.type === "output") events.emit("output", { label: opts.label, text: event.text });
          yield event;
        }
      }
      return { events: tee(), done: agent.done };
    },
  };
}
