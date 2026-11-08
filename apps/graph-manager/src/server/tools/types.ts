// The tools graph-manager offers agents in its terminals, through the `graph-manager-mcp` command (src/server/mcp.ts).
import type { z } from "zod";
import type { AppContext } from "../app.js";
import type { TerminalInfo } from "../terminals.js";
import type { Workspace } from "../workspaces.js";

export interface ToolContext {
  ctx: AppContext;
  /** The calling terminal. */
  terminal: TerminalInfo;
  /** The terminal's workspace (from terminal.workspaceId, else the workspace containing cwd), if any. */
  workspace?: Workspace;
  /** The MCP process's cwd, absolute. */
  cwd: string;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface GmTool<S extends z.ZodType = z.ZodType> {
  /** snake_case, unique. */
  name: string;
  /** Shown to the agent. */
  description: string;
  /** The arguments' schema. */
  input: S;
  run(input: z.infer<S>, tc: ToolContext): Promise<ToolResult>;
}

/** Keeps the input type when registering: `defineTool({ ... })`. */
export function defineTool<S extends z.ZodType>(t: GmTool<S>): GmTool<S> {
  return t;
}
