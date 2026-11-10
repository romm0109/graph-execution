// `propose_graph` (docs/prd/agent-supervisor.md): queues a draft graph for the user to approve or reject in the browser.
import { statSync } from "node:fs";
import { z } from "zod";
import { insideWorkspace, PROVIDERS } from "../routes/runs.js";
import { runOptionsSchema } from "../runoptions.js";
import { folderGraph } from "../runs.js";
import { resolveIn } from "./open-start-run.js";
import { isToolResult, requireWorkspace } from "./run-helpers.js";
import { defineTool } from "./types.js";

const input = z.object({
  tasksDir: z.string().min(1).describe("The task folder, relative to the workspace root or the current directory"),
  spec: z.string().min(1).describe("The spec (PRD) file, relative to the workspace root or the current directory"),
  provider: z.enum(PROVIDERS).optional().describe("Provider to preselect"),
  options: runOptionsSchema.optional().describe("Run options to preselect"),
});

export const proposeGraph = defineTool({
  name: "propose_graph",
  description:
    "Show a task folder you wrote as a draft graph in graph-manager for the user to approve. If they approve, graph-manager's Start run form opens prefilled; if they reject, a line is typed into this terminal. Prefer it over open_start_run. Commit the task folder and spec first. Returns at once.",
  input,
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const relTasks = resolveIn(ws, tc.cwd, i.tasksDir, (f) => statSync(f).isDirectory());
    if (!relTasks) return { isError: true, text: `tasks folder ${i.tasksDir} is not a folder inside the workspace` };
    const relSpec = resolveIn(ws, tc.cwd, i.spec, (f) => statSync(f).isFile());
    if (!relSpec) return { isError: true, text: `spec ${i.spec} is not a file inside the workspace` };
    const full = insideWorkspace(ws, relTasks);
    const graph = full ? await folderGraph(full) : undefined;
    if (!graph || graph.nodes.length === 0) return { isError: true, text: `tasks folder ${relTasks} has no task files` };
    tc.ctx.agentRequests.add({
      kind: "propose-graph",
      terminalId: tc.terminal.id,
      workspaceId: ws.id,
      agent: tc.terminal.agent,
      terminalTitle: tc.terminal.title,
      prefill: { tasksDir: relTasks, spec: relSpec, ...(i.provider ? { provider: i.provider } : {}), ...(i.options ? { options: i.options } : {}) },
    });
    return {
      text: `Showed the graph of ${relTasks} to the user for approval. If they approve, the Start run form opens; if they reject, you'll get a message in this terminal.`,
    };
  },
});
