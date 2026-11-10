// `resume_run` (docs/prd/agent-supervisor.md, KAN-91 #9): resumes a failed, aborted or interrupted run of the calling
// terminal's workspace through `resumeRun`; the calling terminal becomes the run's origin.
import { z } from "zod";
import { resumeRun } from "../routes/resume.js";
import { lastLines } from "../routes/runs.js";
import { SandboxError } from "../sandbox-run.js";
import { closeStoppedPage, fenced, isToolResult, requireWorkspace, runDirOrError } from "./run-helpers.js";
import { defineTool } from "./types.js";

export const resumeRunTool = defineTool({
  name: "resume_run",
  description:
    "Resume a failed, aborted or interrupted run of this workspace from where it stopped (graph-execution --resume). Commit your fix first: resume refuses when the task files, spec or config changed. You become the run's origin and get its events in this terminal.",
  input: z.object({ runId: z.string().min(1).describe("The run id of a failed, aborted or interrupted run") }),
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const runId = i.runId;
    const runDir = await runDirOrError(ws, runId);
    if (typeof runDir !== "string") return runDir;
    // The engine keeps a stopped run's page open (after cancel_run, or while it waits on a failed task): close it first.
    await closeStoppedPage(runDir);
    // Taken before the engine starts: the watcher tells the resumed attempt's state.json writes by it.
    const resumedAt = Date.now();
    try {
      await resumeRun(tc.ctx, ws, runId);
    } catch (err) {
      if (err instanceof SandboxError) {
        const tail = err.output ? lastLines(err.output, 20) : "";
        // A failed engine start carries its output tail as the message too: print it once.
        const text = tail && tail !== err.message ? `${err.message}\n\n${fenced(tail)}` : err.message;
        return { isError: true, text };
      }
      throw err;
    }
    tc.ctx.runOrigins.set(ws.id, runId, tc.terminal.id, { resumedAt });
    return { text: `Resumed run ${runId}. You'll get its events in this terminal.` };
  },
});
