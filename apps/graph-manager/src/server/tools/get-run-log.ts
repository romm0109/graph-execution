// `get_run_log` (docs/prd/agent-supervisor.md, KAN-91): the end of a run's run.log.
import path from "node:path";
import { z } from "zod";
import { fenced, isToolResult, readTailLines, requireWorkspace, runDirOrError } from "./run-helpers.js";
import { defineTool } from "./types.js";

const input = z.object({
  runId: z.string().min(1).describe("The run id, e.g. gm-20261106-100000-abcd"),
  lines: z.number().int().min(1).max(2000).optional().describe("How many lines from the end (default 200)"),
});

export const getRunLogTool = defineTool({
  name: "get_run_log",
  description: "Read the last lines of a graph-execution run's run.log (its engine log) in this workspace.",
  input,
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const runDir = await runDirOrError(ws, i.runId);
    if (typeof runDir !== "string") return runDir;
    const n = i.lines ?? 200;
    const tail = await readTailLines(path.join(runDir, "run.log"), n);
    if (tail === undefined) return { isError: true, text: `run ${i.runId} has no run.log yet` };
    const count = tail === "" ? 0 : tail.split("\n").length;
    const which = count < n ? `all ${count} lines` : `last ${n} lines`;
    return { text: `run.log of ${i.runId} (${which})\n\n${fenced(tail)}` };
  },
});
