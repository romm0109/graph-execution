// `cancel_run` (docs/prd/agent-supervisor.md, KAN-91 #5): stops a run of the calling terminal's workspace like Ctrl+C
// or the UI's Abort; its worktrees and state are kept, so resume_run can continue it.
import { existsSync } from "node:fs";
import path from "node:path";
import { SUITE_FILE } from "graph-execution/api";
import { z } from "zod";
import { upstreamPost } from "../proxy.js";
import { livePage, runDetail } from "../runs.js";
import { isToolResult, pageTarget, requireWorkspace, runDirOrError } from "./run-helpers.js";
import { defineTool } from "./types.js";

const ABORT_TIMEOUT_MS = 5000;

export const cancelRunTool = defineTool({
  name: "cancel_run",
  description:
    "Stop a running graph-execution run of this workspace, like Ctrl+C or Abort in the UI. Its worktrees and state are kept, so resume_run can continue it.",
  input: z.object({ runId: z.string().min(1).describe("The run id") }),
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const runId = i.runId;
    const runDir = await runDirOrError(ws, runId);
    if (typeof runDir !== "string") return runDir;
    const status = async (): Promise<string> => (await runDetail(ws, runId))?.summary.status ?? "unknown";
    const notRunning = async () => ({ isError: true, text: `run ${runId} is not running (${await status()})` });
    const stopped = { text: `Stopped run ${runId}. Resume it with resume_run.` };

    if (existsSync(path.join(runDir, SUITE_FILE))) return { isError: true, text: `run ${runId} is a suite; cancel suites from their terminal` };

    const target = pageTarget(await livePage(runDir));
    if (!target) {
      // A sandboxed run whose page can't be found (Docker inspect failed, no IP yet): stop its container.
      const sandboxes = tc.ctx.sandboxes;
      // Without a page the summary says "interrupted" for a state.json that still says running.
      if (sandboxes?.recordOf(ws.id, runId) && ["running", "interrupted"].includes(await status())) {
        await sandboxes.stop(ws.id, runId);
        return stopped;
      }
      return notRunning();
    }

    let answer: { status: number; body: string };
    try {
      answer = await upstreamPost(target, "/abort", ABORT_TIMEOUT_MS);
    } catch (err) {
      const sandboxes = tc.ctx.sandboxes;
      if (sandboxes?.recordOf(ws.id, runId)) {
        await sandboxes.stop(ws.id, runId);
        return stopped;
      }
      return { isError: true, text: `could not reach the page of run ${runId}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (answer.status === 200) return stopped;
    // The run has ended but its page is still open (waiting for POST /close).
    if (answer.status === 409) return notRunning();
    return { isError: true, text: `the page of run ${runId} answered ${answer.status}` };
  },
});
