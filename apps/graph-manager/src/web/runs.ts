// Shapes of the runs API (src/server/runs.ts) and shared helpers of the Runs and RunDetail pages.

import type { RunSummary } from "./types";

export type { RunSummary };

export interface GraphNode {
  id: string;
  title: string;
  status: string;
}

export interface RunGraph {
  nodes: GraphNode[];
  edges: [string, string][];
  layers: string[][];
}

/** A node of graph-manager's cached run view (src/server/viewcache.ts). Times are epoch ms. */
export interface CachedNode {
  status: string;
  attempt?: number;
  attempts?: number;
  startedAt?: number;
  endedAt?: number;
  added?: number;
  deleted?: number;
  files?: number;
  round?: number;
  rounds?: number;
  error?: string;
}

/** One reviewer of the run with its agent's node and, once the run is over, its open findings by severity. */
export interface CachedReviewer {
  id: string;
  title: string;
  node: CachedNode;
  findings?: { blocker: number; major: number; minor: number };
}

/** The cached copy of a run page's view model, saved while the run was live. */
export interface CachedView {
  version: 1;
  runId: string;
  savedAt: string;
  final: boolean;
  phase: { phase: string; round?: number; fixPasses?: number; humanRound?: number };
  nodes: Record<string, CachedNode>;
  /** The pipeline agents (`gateFixer`, `reviewer`, `tester`, `fixer`) and every other reviewer agent, by agent name. */
  agents: Partial<Record<string, CachedNode>>;
  /** Every reviewer of the run, in order; absent in views cached before KAN-87. */
  reviewers?: CachedReviewer[];
  gate?: CachedNode;
  merge?: CachedNode;
  review?: { round: number; blocking: number; decision?: string };
  summary?: {
    exitCode: number;
    fixPasses: number;
    /** Total findings over the review reports. */
    findings: number;
    abort?: { step: string; message: string };
    merge?: { target: string; ok: boolean; reason?: string };
  };
  testPlan?: { cases: number; pass: number; fail: number; blocked: number };
}

/** One row of the task table. */
export interface TaskRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  added?: number;
  deleted?: number;
  deps: string[];
  error?: string;
}

export interface RunDetailResponse {
  summary: RunSummary;
  state?: {
    runId: string;
    provider: string;
    model?: string;
    createdAt: string;
    status?: string;
    tasks: Record<string, { status: string; attempts: number; branch?: string }>;
    review?: { phase: string; round: number };
  };
  graph?: RunGraph;
  view?: CachedView;
  tasks?: TaskRow[];
  landed?: { files: number; added: number; deleted: number };
}

export const POLL_MS = 2000;

/** The run keys seen so far; undefined until the first answer of the runs list. */
export type RunWatch = Set<string> | undefined;

const runKey = (r: { workspaceId: string; id: string }): string => `${r.workspaceId}/${r.id}`;

/**
 * Feeds one runs list into the watch. The first list only sets the baseline; later, a run not seen before that is
 * live or running (e.g. one an agent just started from a terminal) is returned in `started`, once.
 */
export function nextRunWatch(prev: RunWatch, runs: readonly RunSummary[]): { watch: Set<string>; started: RunSummary[] } {
  const watch = new Set(prev ?? []);
  const started: RunSummary[] = [];
  for (const r of runs) {
    const key = runKey(r);
    if (watch.has(key)) continue;
    if (prev === undefined) watch.add(key);
    else if (r.live || r.status === "running") {
      // A new run that is not running yet (its page still starting) is left unseen, so it is reported once it runs.
      watch.add(key);
      started.push(r);
    }
  }
  return { watch, started };
}

/** `github~octo~hello` → `github/octo/hello`. */
export const workspaceLabel = (id: string): string => id.replaceAll("~", "/");

/** "5s ago", "3m ago", "2h ago", "4d ago", or the date. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/** "merged/total" of a run's tasks, or "" without counts. */
export function taskProgress(counts: Record<string, number> | undefined): string {
  if (!counts) return "";
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return `${counts.merged ?? 0}/${total}`;
}

/** A duration: `48s`, `2m10s`, `1h02m`; `—` for a negative or unknown one. */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
