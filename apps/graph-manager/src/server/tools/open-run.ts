// `open_run` (docs/prd/agent-supervisor.md): queues a request for the browser to show a run.
import { z } from "zod";
import { isToolResult, requireWorkspace, runDirOrError } from "./run-helpers.js";
import { defineTool } from "./types.js";

export const openRun = defineTool({
  name: "open_run",
  description:
    "Show a run of this workspace on the user's screen in graph-manager: in a pane next to this terminal when it is on screen, else as a notification that opens the run page. Returns at once.",
  input: z.object({ runId: z.string().min(1).describe("The run id, e.g. gm-20261109-101500-ab12") }),
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const dir = await runDirOrError(ws, i.runId);
    if (isToolResult(dir)) return dir;
    tc.ctx.agentRequests.add({
      kind: "open-run",
      terminalId: tc.terminal.id,
      workspaceId: ws.id,
      agent: tc.terminal.agent,
      terminalTitle: tc.terminal.title,
      runId: i.runId,
    });
    return { text: `Opened run ${i.runId} in graph-manager.` };
  },
});
