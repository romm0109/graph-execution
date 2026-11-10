import { z } from "zod";
import { cancelRunTool } from "./cancel-run.js";
import { getArtifactsTool } from "./get-artifacts.js";
import { getNodeOutputTool } from "./get-node-output.js";
import { getRunLogTool } from "./get-run-log.js";
import { listGraphsTool } from "./list-graphs.js";
import { listRunsTool } from "./list-runs.js";
import { openGraph } from "./open-graph.js";
import { openRun } from "./open-run.js";
import { openStartRun } from "./open-start-run.js";
import { proposeGraph } from "./propose-graph.js";
import { refreshUi } from "./refresh-ui.js";
import { resumeRunTool } from "./resume-run.js";
import type { GmTool } from "./types.js";

/** graph-manager's tools for agents in its terminals. Add a tool: write src/server/tools/<name>.ts and list it here. */
export const TOOLS: GmTool[] = [
  openStartRun as GmTool,
  listRunsTool as GmTool,
  getRunLogTool as GmTool,
  getNodeOutputTool as GmTool,
  getArtifactsTool as GmTool,
  listGraphsTool as GmTool,
  cancelRunTool as GmTool,
  resumeRunTool as GmTool,
  openRun as GmTool,
  refreshUi as GmTool,
  openGraph as GmTool,
  proposeGraph as GmTool,
];

/** The tools as MCP lists them: name, description and the input's JSON Schema. */
export function toolList(tools: GmTool[] = TOOLS): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input) as Record<string, unknown> }));
}
