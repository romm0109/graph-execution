// `open_start_run` (docs/prd/agent-tools.md): queues a request for the browser to open the Start run popup, prefilled.
import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { insideWorkspace, PROVIDERS } from "../routes/runs.js";
import { runOptionsSchema } from "../runoptions.js";
import type { Workspace } from "../workspaces.js";
import { defineTool } from "./types.js";

const input = z.object({
  tasksDir: z.string().min(1).optional().describe("The task folder, relative to the workspace root or the current directory (workspace terminals only)"),
  spec: z.string().min(1).optional().describe("The spec (PRD) file, relative to the workspace root or the current directory (workspace terminals only)"),
  project: z
    .boolean()
    .optional()
    .describe("Open the Start run form of the terminal's project (multi-repo suite); tasksDir and spec are ignored"),
  provider: z.enum(PROVIDERS).optional().describe("Provider to preselect"),
  options: runOptionsSchema.optional().describe("Run options to preselect"),
});

/** `p` as a workspace-relative path (`/` separators) when it exists inside the workspace and passes `ok`. */
function resolveIn(ws: Workspace, cwd: string, p: string, ok: (full: string) => boolean): string | undefined {
  const candidates = path.isAbsolute(p) ? [p] : [path.resolve(cwd, p), path.resolve(ws.path, p)];
  for (const abs of candidates) {
    const rel = path.relative(ws.path, abs);
    const full = insideWorkspace(ws, rel);
    if (!full) continue;
    try {
      if (!ok(full)) continue;
    } catch {
      continue;
    }
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }
  return undefined;
}

export const openStartRun = defineTool({
  name: "open_start_run",
  description:
    "Open graph-manager's Start run form for the user, prefilled with a task folder and spec. Call it when a task folder is written, validated and committed, instead of starting the run yourself. The user reviews the options and starts the run. In a terminal of a project it opens the project's form (a run across its repos) and needs no paths.",
  input,
  async run(i, tc) {
    const agent = (tc.terminal as { agent?: string }).agent;
    const choices = { ...(i.provider ? { provider: i.provider } : {}), ...(i.options ? { options: i.options } : {}) };
    // A project terminal always targets its project, wherever the agent has `cd`'d to.
    if (tc.project || tc.terminal.projectId || i.project === true) {
      const home = tc.project;
      if (!home) return { isError: true, text: "this terminal is not on a graph-manager project" };
      tc.ctx.agentRequests.add({
        kind: "start-run",
        terminalId: tc.terminal.id,
        workspaceId: home.id,
        projectId: home.project.id,
        agent,
        terminalTitle: tc.terminal.title,
        prefill: choices,
      });
      return {
        text: `Opened the Start run form of project ${home.project.name} in graph-manager. The user will review the options and start the run; do not start it yourself.`,
      };
    }
    const ws = tc.workspace;
    if (!ws) return { isError: true, text: "this terminal is not inside a graph-manager workspace" };
    if (i.tasksDir === undefined || i.spec === undefined) return { isError: true, text: "tasksDir and spec are required in a workspace terminal" };
    const relTasks = resolveIn(ws, tc.cwd, i.tasksDir, (f) => statSync(f).isDirectory());
    if (!relTasks) return { isError: true, text: `tasks folder ${i.tasksDir} is not a folder inside the workspace` };
    const relSpec = resolveIn(ws, tc.cwd, i.spec, (f) => statSync(f).isFile());
    if (!relSpec) return { isError: true, text: `spec ${i.spec} is not a file inside the workspace` };
    tc.ctx.agentRequests.add({
      kind: "start-run",
      terminalId: tc.terminal.id,
      workspaceId: ws.id,
      agent,
      terminalTitle: tc.terminal.title,
      prefill: { tasksDir: relTasks, spec: relSpec, ...choices },
    });
    return {
      text: `Opened the Start run form in graph-manager with tasks folder ${relTasks} and spec ${relSpec}. The user will review the options and start the run; do not start it yourself.`,
    };
  },
});
