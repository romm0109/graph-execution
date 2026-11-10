// `refresh_ui` (docs/prd/agent-supervisor.md): queues a request for every open tab to re-fetch its data.
import { z } from "zod";
import { isToolResult, requireWorkspace } from "./run-helpers.js";
import { defineTool } from "./types.js";

export const refreshUi = defineTool({
  name: "refresh_ui",
  description:
    "Make every open graph-manager tab reload its data now (runs, terminals, the page shown). Use it after you changed files graph-manager shows, e.g. task folders or specs. Returns at once.",
  input: z.object({}),
  async run(_i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    tc.ctx.agentRequests.add({ kind: "refresh", workspaceId: ws.id, agent: tc.terminal.agent, terminalTitle: tc.terminal.title });
    return { text: "Asked graph-manager's open tabs to refresh." };
  },
});
