import { z } from "zod";
import { openStartRun } from "./open-start-run.js";
import type { GmTool } from "./types.js";

/** graph-manager's tools for agents in its terminals. Add a tool: write src/server/tools/<name>.ts and list it here. */
export const TOOLS: GmTool[] = [openStartRun as GmTool];

/** The tools as MCP lists them: name, description and the input's JSON Schema. */
export function toolList(tools: GmTool[] = TOOLS): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input) as Record<string, unknown> }));
}
