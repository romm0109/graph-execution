// `open_start_run` (docs/prd/agent-tools.md): queues a request for the browser to open the Start run popup, prefilled.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { insideWorkspace, PROVIDERS } from "../routes/runs.js";
import { projectWorktreeOfTerminal } from "../routes/terminals.js";
import { runOptionsSchema } from "../runoptions.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";
import { defineTool, type ToolContext, type ToolResult } from "./types.js";

const input = z.object({
  tasksDir: z.string().min(1).optional().describe(
      "The task folder, relative to the workspace root or the current directory; in a project terminal, both must be inside the same repo under repos/",
    ),
  spec: z.string().min(1).optional().describe(
      "The spec (PRD) file, relative to the workspace root or the current directory; in a project terminal, both must be inside the same repo under repos/",
    ),
  project: z
    .boolean()
    .optional()
    .describe("Open the project's suite form (all repos); tasksDir and spec are ignored"),
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
    "Open graph-manager's Start run form for the user, prefilled. Call it when a task folder is written, validated and committed, instead of starting the run yourself. In a workspace terminal pass tasksDir and spec. In a project terminal pass project: true for a run across all repos, or tasksDir and spec inside one repo for a normal run of that repo.",
  input,
  async run(i, tc) {
    const agent = (tc.terminal as { agent?: string }).agent;
    const choices = { ...(i.provider ? { provider: i.provider } : {}), ...(i.options ? { options: i.options } : {}) };
    // project: true → the project's suite form; in a project terminal, paths inside one repo → that repo's form.
    if (i.project === true) {
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
    if (tc.terminal.projectId || (tc.project && !tc.terminal.workspaceId)) return repoRun(i, tc, agent, choices);
    const home = tc.workspace;
    if (!home) return { isError: true, text: "this terminal is not inside a graph-manager workspace" };
    // A terminal with its own worktree (docs/prd/done/isolated-workspaces.md): the paths are relative to that worktree, where
    // the run's Start run form reads them too.
    const worktree = (tc.terminal as { worktree?: { path: string } }).worktree;
    const ws: Workspace = worktree ? { ...home, path: worktree.path } : home;
    if (i.tasksDir === undefined || i.spec === undefined) return { isError: true, text: "tasksDir and spec are required in a workspace terminal" };
    const relTasks = resolveIn(ws, tc.cwd, i.tasksDir, (f) => statSync(f).isDirectory());
    if (!relTasks) return { isError: true, text: `tasks folder ${i.tasksDir} is not a folder inside the workspace` };
    const relSpec = resolveIn(ws, tc.cwd, i.spec, (f) => statSync(f).isFile());
    if (!relSpec) return { isError: true, text: `spec ${i.spec} is not a file inside the workspace` };
    tc.ctx.agentRequests.add({
      kind: "start-run",
      terminalId: tc.terminal.id,
      workspaceId: home.id,
      agent,
      terminalTitle: tc.terminal.title,
      prefill: { tasksDir: relTasks, spec: relSpec, ...choices },
    });
    return {
      text: `Opened the Start run form in graph-manager with tasks folder ${relTasks} and spec ${relSpec}. The user will review the options and start the run; do not start it yourself.`,
    };
  },
});

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

const within = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * A normal run of one repo of a project terminal (docs/prd/project-terminal-worktrees.md, "Single-repo runs from a
 * project terminal"): both paths must be inside the same `repos/<name>` of the terminal's folder.
 */
function repoRun(
  i: z.infer<typeof input>,
  tc: ToolContext,
  agent: string | undefined,
  choices: { provider?: (typeof PROVIDERS)[number]; options?: z.infer<typeof runOptionsSchema> },
): ToolResult {
  if (i.tasksDir === undefined || i.spec === undefined) {
    return { isError: true, text: "pass project: true for a run across the project's repos, or tasksDir and spec inside one repo" };
  }
  const projectId = tc.terminal.projectId ?? tc.project?.project.id;
  const stored = projectId ? tc.ctx.store.project(projectId) : undefined;
  const projectName = tc.project?.project.name ?? stored?.name ?? projectId ?? "";
  const wt = projectWorktreeOfTerminal(tc.ctx, tc.terminal.id);
  const folder = wt?.[1].path ?? tc.terminal.cwd;
  const reposDir = path.join(folder, "repos");
  const repos: { name: string; real: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(reposDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const link = path.join(reposDir, name);
    try {
      if (!lstatSync(link).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const r = real(link);
    if (r) repos.push({ name, real: r });
  }
  const locate = (p: string): { repo: { name: string; real: string }; abs: string } | undefined => {
    const candidates = path.isAbsolute(p) ? [p] : [path.resolve(tc.cwd, p), path.resolve(folder, p)];
    for (const c of candidates) {
      const r = real(c);
      if (!r) continue;
      const repo = repos.find((x) => within(r, x.real));
      if (repo) return { repo, abs: r };
    }
    return undefined;
  };
  const t = locate(i.tasksDir);
  if (!t) return { isError: true, text: `${i.tasksDir} is not inside a repo of project ${projectName}` };
  const s = locate(i.spec);
  if (!s) return { isError: true, text: `${i.spec} is not inside a repo of project ${projectName}` };
  if (t.repo.name !== s.repo.name) return { isError: true, text: `tasksDir and spec are in different repos (${t.repo.name}, ${s.repo.name})` };
  const repo = t.repo;
  // The repo's workspace: the record's for an isolated repo, else the project workspace whose checkout the link is.
  const root = path.resolve(tc.ctx.config.workspacesDir);
  const recId = wt?.[1].repos.find((r) => r.name === repo.name)?.workspaceId;
  let workspace = recId ? resolveWorkspace(root, recId) : undefined;
  if (!workspace) {
    const ids = tc.project?.project.workspaces ?? stored?.workspaces ?? [];
    workspace = ids
      .map((id) => resolveWorkspace(root, id))
      .find((w): w is Workspace => w !== undefined && real(w.path) === repo.real);
  }
  if (!workspace) return { isError: true, text: `repo ${repo.name} has no graph-manager workspace` };
  const ws: Workspace = { ...workspace, path: repo.real };
  const relTasks = resolveIn(ws, tc.cwd, t.abs, (f) => statSync(f).isDirectory());
  if (!relTasks) return { isError: true, text: `tasks folder ${i.tasksDir} is not a folder inside repo ${repo.name}` };
  const relSpec = resolveIn(ws, tc.cwd, s.abs, (f) => statSync(f).isFile());
  if (!relSpec) return { isError: true, text: `spec ${i.spec} is not a file inside repo ${repo.name}` };
  tc.ctx.agentRequests.add({
    kind: "start-run",
    terminalId: tc.terminal.id,
    workspaceId: workspace.id,
    repo: repo.name,
    agent,
    terminalTitle: tc.terminal.title,
    prefill: { tasksDir: relTasks, spec: relSpec, ...choices },
  });
  return {
    text: `Opened the Start run form of repo ${repo.name} in graph-manager with tasks folder ${relTasks} and spec ${relSpec}. The user will review the options and start the run; do not start it yourself.`,
  };
}
