// `list_runs` (docs/prd/agent-supervisor.md, KAN-91): the runs of the calling terminal's workspace, newest first.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stateSchema } from "graph-execution/api";
import { z } from "zod";
import { listWorkspaceRuns, newestFirst, runDirOf, type RunSummary } from "../runs.js";
import { supervisorModeOf } from "../store.js";
import type { Workspace } from "../workspaces.js";
import { isToolResult, requireWorkspace, table, workspaceRel } from "./run-helpers.js";
import { defineTool } from "./types.js";

const STATUSES = ["running", "failed", "applied", "done", "aborted", "interrupted"] as const;

const input = z.object({
  status: z.enum(STATUSES).optional().describe("Only runs with this status"),
  limit: z.number().int().min(1).max(100).optional().describe("How many runs, newest first (default 20)"),
});

/** The run's task folder, workspace-relative; "" for a suite or an unreadable state.json. */
async function tasksDirOf(ws: Workspace, r: RunSummary): Promise<string> {
  if (r.type !== "run") return "";
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path.join(runDirOf(ws, r.id), "state.json"), "utf8")));
    return parsed.success ? workspaceRel(ws, parsed.data.tasksDir) : "";
  } catch {
    return "";
  }
}

function tasksOf(r: RunSummary): string {
  if (r.type !== "run" || !r.taskCounts) return "";
  const c = r.taskCounts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const failed = c.failed ?? 0;
  return `${c.merged ?? 0}/${total} merged${failed > 0 ? `, ${failed} failed` : ""}`;
}

export const listRunsTool = defineTool({
  name: "list_runs",
  description:
    "List the graph-execution runs of this workspace, newest first, with their status, failure and task progress. The first line is the workspace's Supervisor mode: what to do when a run fails (report: tell the user; act: fix and resume).",
  input,
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const data = tc.ctx.store.get();
    const head = `Supervisor: ${supervisorModeOf(data, ws.id)}`;
    const all = (await listWorkspaceRuns(ws, data.prs, tc.ctx.config.dataDir)).sort(newestFirst);
    const matched = i.status ? all.filter((r) => r.status === i.status) : all;
    if (matched.length === 0) {
      return { text: `${head}\n\n${i.status && all.length > 0 ? `No runs with status ${i.status} in this workspace.` : "No runs in this workspace."}` };
    }
    const shown = matched.slice(0, i.limit ?? 20);
    const rows = await Promise.all(
      shown.map(async (r) => [r.id, r.status, r.failure ?? "", tasksOf(r), r.createdAt ?? "", await tasksDirOf(ws, r)]),
    );
    const more = matched.length - shown.length;
    const parts = [head, "", table(["run", "status", "failure", "tasks", "started", "tasksDir"], rows)];
    if (more > 0) parts.push("", `(${more} more; pass limit to see them)`);
    return { text: parts.join("\n") };
  },
});
