// `open_graph` (docs/prd/agent-supervisor.md): queues a request for the browser to show a run's or a task folder's graph.
import { statSync } from "node:fs";
import { z } from "zod";
import { insideWorkspace } from "../routes/runs.js";
import { folderGraph, runDetail } from "../runs.js";
import { resolveIn } from "./open-start-run.js";
import { isToolResult, requireWorkspace, runDirOrError } from "./run-helpers.js";
import { defineTool } from "./types.js";

const input = z.object({
  runId: z.string().min(1).optional().describe("A run of this workspace: opens its run page"),
  tasksDir: z
    .string()
    .min(1)
    .optional()
    .describe("A task folder, relative to the workspace root or the current directory: opens a preview of its graph"),
  node: z.string().min(1).optional().describe("A task id to select in the graph"),
});

export const openGraph = defineTool({
  name: "open_graph",
  description:
    "Show a task graph on the user's screen in graph-manager: a run's graph (runId) or a task folder's graph (tasksDir), optionally focused on one node. Pass exactly one of runId and tasksDir. Returns at once.",
  input,
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    if ((i.runId === undefined) === (i.tasksDir === undefined)) return { isError: true, text: "pass exactly one of runId and tasksDir" };
    const base = { kind: "open-graph" as const, terminalId: tc.terminal.id, workspaceId: ws.id, agent: tc.terminal.agent, terminalTitle: tc.terminal.title };
    const nodeText = i.node ? ` Node ${i.node} is selected.` : "";
    if (i.runId !== undefined) {
      const dir = await runDirOrError(ws, i.runId);
      if (isToolResult(dir)) return dir;
      if (i.node !== undefined) {
        const ids = (await runDetail(ws, i.runId))?.graph?.nodes.map((n) => n.id) ?? [];
        if (!ids.includes(i.node)) return { isError: true, text: `unknown node ${i.node} in run ${i.runId}; nodes: ${ids.join(", ")}` };
      }
      tc.ctx.agentRequests.add({ ...base, runId: i.runId, ...(i.node ? { node: i.node } : {}) });
      return { text: `Opened the graph of run ${i.runId} in graph-manager.${nodeText}` };
    }
    const tasksDir = i.tasksDir!;
    const rel = resolveIn(ws, tc.cwd, tasksDir, (f) => statSync(f).isDirectory());
    if (!rel) return { isError: true, text: `tasks folder ${tasksDir} is not a folder inside the workspace` };
    const full = insideWorkspace(ws, rel);
    const graph = full ? await folderGraph(full) : undefined;
    if (!graph || graph.nodes.length === 0) return { isError: true, text: `tasks folder ${rel} has no task files` };
    if (i.node !== undefined) {
      const ids = graph.nodes.map((n) => n.id);
      if (!ids.includes(i.node)) return { isError: true, text: `unknown node ${i.node} in ${rel}; nodes: ${ids.join(", ")}` };
    }
    tc.ctx.agentRequests.add({ ...base, tasksDir: rel, ...(i.node ? { node: i.node } : {}) });
    return { text: `Opened the graph of ${rel} in graph-manager.${nodeText}` };
  },
});
