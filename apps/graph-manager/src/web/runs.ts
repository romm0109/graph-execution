// Shapes of the runs API (src/server/runs.ts) and shared helpers of the Runs and RunDetail pages.

export interface RunSummary {
  workspaceId: string;
  type: "run" | "suite";
  id: string;
  status: string;
  kind: string;
  live: boolean;
  viewUrl?: string;
  createdAt?: string;
  provider?: string;
  taskCounts?: Record<string, number>;
}

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

export interface RunDetailResponse {
  summary: RunSummary;
  state?: { runId: string; provider: string; model?: string; createdAt: string; tasks: Record<string, { status: string; attempts: number; branch?: string }> };
  graph?: RunGraph;
}

export const POLL_MS = 2000;

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
