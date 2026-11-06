import type { AttemptFailure } from "../agents/retry.js";
import type { Finding, Report } from "../review/report.js";

/** The steps of the phase bar (PRD §7.9). */
export type RunPhase = "tasks" | "validate" | "review" | "fix" | "human" | "done";

export interface PhaseChange {
  phase: RunPhase;
  /** The review round (`review`) or the fix pass (`fix`). */
  round?: number;
  /** The fix pass budget (`config.fixPasses`), for `fix pass N/M`. */
  fixPasses?: number;
  /** The human review round this fix loop answers, 1-based. */
  humanRound?: number;
}

/** The phase as one line of text: `tasks`, `validate`, `review round N`, `fix pass N/M`, `done`. */
export function phaseLabel({ phase, round = 0, fixPasses, humanRound }: PhaseChange): string {
  if (phase === "review") return `review round ${round}`;
  if (phase === "human") return `human review ${round}`;
  if (phase === "fix") {
    const pass = fixPasses === undefined ? `fix pass ${round}` : `fix pass ${round}/${fixPasses}`;
    return humanRound ? `${pass} (human round ${humanRound})` : pass;
  }
  return phase;
}

/**
 * The review-phase agents that get a node of their own in the UI. `gateFixer` is the fixer sent a failing validation
 * gate before the first review.
 */
export type ReviewAgent = "reviewer" | "tester" | "fixer" | "gateFixer";

/** A file the final merge changed, from `git diff --numstat`; binary files count 0 lines. */
export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  /** A file the run creates: left untracked in the user's checkout. */
  isNew?: boolean;
  /** The change deletes the file. */
  isDeleted?: boolean;
  /** Binary file: counts are 0 and there is no text diff. */
  binary?: boolean;
}

/** What a node has changed so far, for the live change view. */
export interface NodeChanges {
  /** Sorted by path. */
  files: ChangedFile[];
  total: { added: number; deleted: number; files: number };
}

/**
 * The integration branch applied to the branch the run started from as uncommitted changes, once the review is
 * clean.
 */
export interface TargetMerge {
  /** The branch the run started from. */
  target: string;
  ok: boolean;
  /** Why it was not applied, or failed and was rolled back. */
  reason?: string;
  /** The uncommitted changes it left in `target`'s checkout, conflicted files excepted. */
  files: ChangedFile[];
  /** Files left as merge conflicts, with the run's and the user's (or `target`'s) changes overlapping. */
  conflicts?: string[];
  /** The stash commit with the user's own uncommitted changes from before the apply, kept in the stash list. */
  backup?: string;
  /** The run's commits those changes come from, one line each, oldest first. */
  commits: string[];
}

/** How a run ended, for the final summary (PRD §7.9, §7.11). */
export interface RunEnd {
  runId: string;
  /** `graph/<run-id>` */
  branch: string;
  /** 0 clean, 1 review loop exhausted, 2 aborted. */
  exitCode: number;
  /** The last review round's reports, empty when the run never got that far. */
  reports: Report[];
  /** The fix pass budget, for the exit 1 message. */
  fixPasses: number;
  /** `.graph-execution/<run-id>` */
  runDir: string;
  /** Set for an abort: what failed and the exact command to resume. */
  abort?: { step: string; message: string; hint: string };
  /** The result applied to the starting branch; absent when that was not attempted (exit 1 or 2, `--no-merge`). */
  merge?: TargetMerge;
  /** The human's decision when the run paused for a review. */
  human?: { decision: "apply" | "drop"; openFindings: number };
  /** Every time an agent was stopped for repeating the same tool call, in order; absent when none. */
  loopStops?: { label: string; why: string }[];
}

/** Scheduler events of a run, for the TUI and logs. */
export interface RunEventMap {
  "task:start": { taskId: string };
  /** Attempt `attempt` of `attempts` starts after `reason` made the previous one fail. */
  "task:retry": { taskId: string; attempt: number; attempts: number; reason: AttemptFailure };
  "task:merged": { taskId: string; mergeCommit: string };
  "task:failed": { taskId: string; error: unknown };
  /**
   * A task moved on from its agent attempts to the validation gate or to its merge. `fixing` is a validation fix
   * round: the failure went back to the agent. `round` is the fix round (`fixing`), or the fix round just finished
   * (`validating` again), of `rounds`.
   */
  "task:status": { taskId: string; status: "validating" | "merging" | "fixing"; round?: number; rounds?: number };
  /** The run's phase bar (PRD §7.9); emitted once per change. */
  "phase:change": PhaseChange;
  "review:start": { round: number };
  "review:end": { round: number; reports: Report[] };
  /** The run waits for the human's review in round `round`; `blocking` are the open blocker/major findings. */
  "review:waiting": { round: number; reviewRound?: number; blocking: Finding[] };
  "review:decided": { decision: "apply" | "drop" | "changes" };
  /** Fix pass `pass` of `passes`. */
  "fix:start": { pass: number; passes: number };
  "fix:end": { pass: number };
  /** A review-phase agent starts its first attempt; `label` is its output label (`code-r0`, `fix-r1`, ...). */
  "agent:start": { agent: ReviewAgent; label: string };
  "agent:retry": { agent: ReviewAgent; label: string; attempt: number; attempts: number; reason: AttemptFailure };
  /**
   * The fixer's commit is going through the validation gate, or a failing gate went back to the fixer (`fixing`,
   * under a new `label`). `round` and `rounds` as for `task:status`.
   */
  "agent:status": { agent: ReviewAgent; status: "validating" | "fixing"; round?: number; rounds?: number; label?: string };
  "agent:end": { agent: ReviewAgent; label: string; ok: boolean };
  /** The result applied to the starting branch (PRD §7.11): `skipped` when it is not done. */
  "merge:status": { status: "running" | "done" | "failed" | "skipped" };
  /** The run is over; the UI shows the final summary. */
  "run:end": RunEnd;
  /** The run re-enters after a failure, to retry `nodeId` in this same process. */
  "run:restart": { nodeId: string };
  /** The run waits for a retry of one of `nodes`; `[]` when it stops waiting or restarts. */
  "retry:available": { nodes: string[]; merge?: boolean };
  /** The AI summary of a failed node: `pending` while the provider call runs, then `ready` or `unavailable`. */
  "failure:info": {
    nodeId: string;
    error: string;
    summary:
      | { status: "pending" }
      | { status: "unavailable" }
      | { status: "ready"; cause: string; verdict: "likely_to_work" | "unlikely_to_help" | "unclear"; why: string };
  };
  /** Start re-diffing `worktree` against `base` while the node's agent runs; `exclude` were dirty before it started. */
  "changes:track": { nodeId: string; worktree: string; base: string; exclude?: string[] };
  /** The node's agent stopped: take one last snapshot and stop polling. */
  /** With `repo` and `to` the node is finished: its diff is `base..to` in `repo` from now on, not its worktree's. */
  "changes:stop": { nodeId: string; repo?: string; to?: string };
  /** A new attempt starts: the node's changes are cleared. */
  "changes:reset": { nodeId: string };
  /** A node's changes, emitted only when they differ from the last ones. */
  nodeChanges: { nodeId: string; changes: NodeChanges };
  /** A chunk of an agent's output; `label` is the agent's label (the task id for task agents). */
  output: { label: string; text: string };
}

export type RunEventType = keyof RunEventMap;
export type RunEventListener<K extends RunEventType> = (payload: RunEventMap[K]) => void;

export class RunEmitter {
  private readonly listeners = new Map<RunEventType, Set<RunEventListener<never>>>();

  /** Registers `listener` for `type`; returns a function that removes it. */
  on<K extends RunEventType>(type: K, listener: RunEventListener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as RunEventListener<never>);
    return () => set.delete(listener as RunEventListener<never>);
  }

  emit<K extends RunEventType>(type: K, payload: RunEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as RunEventListener<K>)(payload);
  }
}
