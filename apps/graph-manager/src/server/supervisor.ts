import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { stateSchema, type RunState } from "graph-execution/api";
import type { AppContext } from "./app.js";
import type { RunOrigin } from "./run-origins.js";
import { listWorkspaceRuns, runDirOf } from "./runs.js";
import { supervisorModeOf, type SupervisorMode } from "./store.js";
import { resolveWorkspace, type Workspace } from "./workspaces.js";

/**
 * The run event watcher (KAN-92, docs/prd/agent-supervisor.md): polls the runs that have an origin terminal, diffs each
 * run's status and review step with what it saw last, and types one `[graph-manager] …` line per event into that terminal.
 */

export type RunEvent =
  | { kind: "started"; runId: string; tasksDir: string }
  | { kind: "resumed"; runId: string }
  | { kind: "review"; runId: string }
  | { kind: "succeeded"; runId: string; status: string }
  | { kind: "failed"; runId: string; failure: string }
  | { kind: "cancelled"; runId: string };

/** What the watcher knows about one run at one tick. */
export interface RunSnapshot {
  type: "run" | "suite";
  /** RunSummary.status */
  status: string;
  /** RunSummary.failure */
  failure?: string;
  /** Workspace-relative, "/" separators, from state.json. */
  tasksDir?: string;
  /** See reviewStepOf. */
  reviewStep?: string;
  /**
   * The run still says `running`, but a task failed and nothing is in flight: a `--web` run waits for Retry, Merge or
   * Close in its page (see waitingFailedTask). The snapshot then has status `failed`, so the agent learns of it.
   */
  waiting?: boolean;
  /** mtime of state.json (ms); tells a resumed attempt's writes from the previous attempt's. */
  stateMtimeMs?: number;
}
export interface SeenRun {
  /** A RunSummary status, or RESUMING: a resume was recorded and the watcher hasn't diffed the resumed attempt yet. */
  status: string;
  reviewStep?: string;
  /** RunOrigin.epoch at the time of this diff. */
  epoch?: number;
}

/** SeenRun.status of a run whose resume was recorded: the next diff reports `resumed` and the attempt's end. */
export const RESUMING = "resuming";
/** How long the watcher waits for a resumed attempt to write state.json before it diffs as usual. */
const RESUME_WAIT_MS = 60_000;
/** An origin whose run folder still doesn't exist after this long is dropped (the engine failed at startup). */
export const ORPHAN_ORIGIN_MS = 60_000;
/** Slack for file systems with a coarse mtime. */
const MTIME_SLACK_MS = 1000;

const P = "[graph-manager] ";

/** The review step of a run: `review.phase` once every task is merged (the review runs after that), else undefined. */
export function reviewStepOf(state: RunState): string | undefined {
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0 || !tasks.every((t) => t.status === "merged")) return undefined;
  return state.review.phase;
}

/**
 * The failed task a live run waits on: state.json says `running`, a task is `failed` and none is in flight. A `--web`
 * run does this after a task's last attempt fails, until the user presses Retry, Merge or Close in its page.
 */
export function waitingFailedTask(state: RunState): string | undefined {
  if (state.status !== "running") return undefined;
  const tasks = Object.entries(state.tasks);
  if (tasks.some(([, t]) => t.status === "running" || t.status === "validating" || t.status === "merging")) return undefined;
  return tasks.find(([, t]) => t.status === "failed")?.[0];
}

export function eventLine(e: RunEvent, mode: SupervisorMode): string {
  const id = e.runId;
  switch (e.kind) {
    case "started":
      return `${P}Run ${id} started (${e.tasksDir}).`;
    case "resumed":
      return `${P}Run ${id} was resumed.`;
    case "review":
      return `${P}Run ${id} entered review.`;
    case "succeeded":
      return `${P}Run ${id} succeeded (${e.status}). Call get_artifacts to see what it wrote, open_run to show it.`;
    case "cancelled":
      return `${P}Run ${id} was cancelled.`;
    case "failed":
      return (
        `${P}Run ${id} failed: ${e.failure}. ` +
        (mode === "act"
          ? `Supervisor: act. Find the cause with get_run_log and get_node_output, fix it, commit, then call resume_run with runId ${id}.`
          : `Supervisor: report. Tell the user what failed and why (get_run_log, get_node_output); do not change code or rerun.`)
      );
  }
}

type EndKind = "succeeded" | "failed" | "cancelled";

function endKind(status: string): EndKind | undefined {
  if (status === "applied" || status === "done") return "succeeded";
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "aborted") return "cancelled";
  return undefined;
}

function cleanFailure(cur: RunSnapshot): string {
  const f = cur.failure
    ?.replace(/[\r\n]+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
  if (f) return f;
  return cur.status === "interrupted" ? "interrupted" : "failed";
}

function endOf(runId: string, cur: RunSnapshot): RunEvent | undefined {
  switch (endKind(cur.status)) {
    case "succeeded":
      return { kind: "succeeded", runId, status: cur.status };
    case "failed":
      return { kind: "failed", runId, failure: cleanFailure(cur) };
    case "cancelled":
      return { kind: "cancelled", runId };
    default:
      return undefined;
  }
}

/** The events between what the watcher saw last (`prev`, undefined on first sight) and now, in order. */
export function diffRun(runId: string, prev: SeenRun | undefined, cur: RunSnapshot): RunEvent[] {
  const end = endOf(runId, cur);
  if (!prev) {
    return [
      { kind: "started", runId, tasksDir: cur.tasksDir ?? "unknown task folder" },
      ...(cur.reviewStep ? [{ kind: "review", runId } as const] : []),
      ...(end ? [end] : []),
    ];
  }
  const out: RunEvent[] = [];
  const resuming = prev.status === RESUMING;
  if (resuming || (["failed", "aborted", "interrupted"].includes(prev.status) && cur.status === "running")) out.push({ kind: "resumed", runId });
  if (!prev.reviewStep && cur.reviewStep) out.push({ kind: "review", runId });
  // failed → interrupted is not a second failure; a resumed attempt's end always is a new event.
  if (end && (resuming || endKind(prev.status) !== end.kind)) out.push(end);
  return out;
}

async function readState(runDir: string): Promise<RunState | undefined> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshots of the given runs of one workspace; a run without a summary yet is missing from the map. */
export async function snapshotRuns(ws: Workspace, runIds: ReadonlySet<string>, dataDir?: string): Promise<Map<string, RunSnapshot>> {
  const out = new Map<string, RunSnapshot>();
  const runs = await listWorkspaceRuns(ws, undefined, dataDir);
  for (const r of runs) {
    if (!runIds.has(r.id)) continue;
    const snap: RunSnapshot = { type: r.type, status: r.status, ...(r.failure !== undefined ? { failure: r.failure } : {}) };
    if (r.type === "run") {
      const runDir = runDirOf(ws, r.id);
      const state = await readState(runDir);
      try {
        snap.stateMtimeMs = (await stat(path.join(runDir, "state.json"))).mtimeMs;
      } catch {
        // no state.json yet
      }
      if (state) {
        const waitingOn = r.status === "running" ? waitingFailedTask(state) : undefined;
        if (waitingOn !== undefined) {
          snap.status = "failed";
          snap.failure = `task ${waitingOn} failed (the run waits in its page; resume_run closes it and resumes)`;
          snap.waiting = true;
        }
        snap.tasksDir = path.relative(ws.path, state.tasksDir).split(path.sep).join("/") || ".";
        const step = reviewStepOf(state);
        if (step !== undefined) snap.reviewStep = step;
      }
    }
    out.set(r.id, snap);
  }
  return out;
}

export interface RunEventWatcherOptions {
  /** Poll interval; default ctx.config.supervisorPollMs ?? 2000. */
  intervalMs?: number;
  /** Replaces snapshotRuns (tests). */
  snapshot?: (ws: Workspace, runIds: ReadonlySet<string>) => Promise<Map<string, RunSnapshot>>;
}

export class RunEventWatcher {
  private readonly intervalMs: number;
  private readonly snapshot: (ws: Workspace, runIds: ReadonlySet<string>) => Promise<Map<string, RunSnapshot>>;
  private readonly seen = new Map<string, SeenRun>();
  /** Runs seen once in a state that is believed only on the second sight (see `doubtful` in run). */
  private readonly sightedOnce = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;

  constructor(
    private readonly ctx: Pick<AppContext, "config" | "store" | "terminals" | "runOrigins">,
    opts: RunEventWatcherOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? ctx.config.supervisorPollMs ?? 2000;
    this.snapshot = opts.snapshot ?? ((ws, ids) => snapshotRuns(ws, ids, ctx.config.dataDir));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Clears the timer and waits for a running tick. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current;
  }

  /** One poll; never overlaps another and never throws. */
  tick(): Promise<void> {
    if (this.current) return this.current;
    this.current = this.run().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private forget(key: string): void {
    this.seen.delete(key);
    this.sightedOnce.delete(key);
  }

  private async run(): Promise<void> {
    const { config, store, terminals, runOrigins } = this.ctx;
    const byWs = new Map<string, RunOrigin[]>();
    for (const o of runOrigins.entries()) {
      const list = byWs.get(o.wsId) ?? [];
      list.push(o);
      byWs.set(o.wsId, list);
    }
    const now = Date.now();
    for (const [wsId, origins] of byWs) {
      try {
        const ws = resolveWorkspace(config.workspacesDir, wsId);
        if (!ws) {
          for (const o of origins) {
            runOrigins.delete(wsId, o.runId);
            this.forget(`${wsId}/${o.runId}`);
          }
          continue;
        }
        // An origin whose terminal no longer exists is deleted.
        const alive = origins.filter((o) => {
          if (terminals.get(o.terminalId)) return true;
          runOrigins.delete(wsId, o.runId);
          this.forget(`${wsId}/${o.runId}`);
          return false;
        });
        if (alive.length === 0) continue;
        const snaps = await this.snapshot(ws, new Set(alive.map((o) => o.runId)));
        for (const origin of alive) {
          const { runId, terminalId } = origin;
          const key = `${wsId}/${runId}`;
          const cur = snaps.get(runId);
          if (!cur) {
            // No run folder yet: wait, but not forever (the engine refused to start: bad args, a dirty tree, …).
            if (!this.seen.has(key) && now - origin.setAt > ORPHAN_ORIGIN_MS) {
              runOrigins.delete(wsId, runId);
              this.forget(key);
            }
            continue;
          }
          // state.json isn't written yet: wait.
          if (cur.status === "unknown") continue;
          // Suites are a non-goal.
          if (cur.type === "suite") {
            runOrigins.delete(wsId, runId);
            this.forget(key);
            continue;
          }
          // A hand-off between the launcher and the detached engine can look "interrupted" for one poll, and the scheduler
          // can sit for a moment between a failed task and the next one: believe both on the second sight.
          const doubtful = cur.status === "interrupted" || cur.waiting === true;
          if (doubtful && !this.sightedOnce.has(key)) {
            this.sightedOnce.add(key);
            continue;
          }
          if (!doubtful) this.sightedOnce.delete(key);
          let prev = this.seen.get(key);
          if (origin.resumedAt !== undefined && prev?.epoch !== origin.epoch) {
            // A resume was recorded since the last diff. Until the resumed attempt shows (running, or state.json written
            // after the resume), the summary still has the previous attempt's end: wait for it.
            const fresh = cur.status === "running" || (cur.stateMtimeMs ?? 0) >= origin.resumedAt - MTIME_SLACK_MS;
            if (!fresh && now - origin.resumedAt < RESUME_WAIT_MS) continue;
            if (fresh) prev = { status: RESUMING, ...(prev?.reviewStep !== undefined ? { reviewStep: prev.reviewStep } : {}) };
          }
          const events = diffRun(runId, prev, cur);
          this.seen.set(key, {
            status: cur.status,
            epoch: origin.epoch,
            ...(cur.reviewStep !== undefined ? { reviewStep: cur.reviewStep } : {}),
          });
          if (events.length === 0) continue;
          // Read at event time: the user may switch the workspace's Supervisor mode mid-run.
          const mode = supervisorModeOf(store.get(), wsId);
          for (const e of events) terminals.typeWhenIdle(terminalId, eventLine(e, mode));
        }
      } catch {
        // Keep going: a tick must never throw out of the timer.
      }
    }
  }
}
