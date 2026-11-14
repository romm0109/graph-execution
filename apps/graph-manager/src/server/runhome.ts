// Where runs live (docs/prd/multi-repo.md, MR-08): a workspace, or a project's folder under the id `project~<id>`.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { projectOf, toProject, type ProjectRecord, type UserStore } from "./store.js";
import { PROJECTS_DIR, projectDirOf, readProjectFile, type Project } from "./projects.js";
import { resolveWorkspace, type Workspace } from "./workspaces.js";

export const PROJECT_PREFIX = "project~";

export type RunHome =
  | { kind: "workspace"; id: string; path: string; workspace: Workspace }
  | { kind: "project"; id: string; path: string; project: Project };

export type ProjectHome = Extract<RunHome, { kind: "project" }>;

const PROJECT_ID = /^[a-z0-9-]+$/;

/** The home of a stored project, or undefined when its id is unsafe or its folder is not a git repo. */
export function projectHome(
  workspacesDir: string,
  id: string,
  rec: ProjectRecord | Project | undefined,
): ProjectHome | undefined {
  if (!rec || !PROJECT_ID.test(id)) return undefined;
  const dir = projectDirOf(workspacesDir, id);
  if (!existsSync(path.join(dir, ".git"))) return undefined;
  return { kind: "project", id: `${PROJECT_PREFIX}${id}`, path: dir, project: toProject(id, rec) };
}

/** `project~<id>` → the project folder (store record + `<workspacesDir>/.projects/<id>/.git`), else `resolveWorkspace`. */
export function resolveRunHome(workspacesDir: string, us: UserStore, id: string): RunHome | undefined {
  if (id.startsWith(PROJECT_PREFIX)) {
    const pid = id.slice(PROJECT_PREFIX.length);
    if (!PROJECT_ID.test(pid)) return undefined;
    return projectHome(workspacesDir, pid, projectOf(us.get(), pid));
  }
  const ws = resolveWorkspace(workspacesDir, id);
  return ws && workspaceHome(ws);
}

export const workspaceHome = (ws: Workspace): RunHome => ({ kind: "workspace", id: ws.id, path: ws.path, workspace: ws });

/**
 * A `Workspace`-shaped view of a home for the code that takes one (summaries, sandbox paths): a project is
 * `forge: "project"`, `rel: ".projects/<id>"`.
 */
export function homeAsWorkspace(home: RunHome): Workspace {
  if (home.kind === "workspace") return home.workspace;
  const pid = home.project.id;
  return { id: home.id, path: home.path, rel: `${PROJECTS_DIR}/${pid}`, forge: "project", fullPath: pid };
}

function realOf(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/**
 * The project's repos in project.json order: link name + its workspace (matched by realpath of `<dir>/<repo.path>`
 * against each workspace's realpath). Repos whose link or workspace is missing get `workspace: undefined`.
 */
export async function projectRepos(workspacesDir: string, home: ProjectHome): Promise<{ name: string; path: string; workspace?: Workspace }[]> {
  const file = await readProjectFile(home.path);
  if (!file) return [];
  const workspaces = home.project.workspaces
    .map((id) => resolveWorkspace(workspacesDir, id))
    .filter((ws): ws is Workspace => ws !== undefined)
    .map((ws) => ({ ws, real: realOf(ws.path) }));
  return file.repos.map((repo) => {
    const real = realOf(path.resolve(home.path, repo.path));
    const workspace = real === undefined ? undefined : workspaces.find((w) => w.real === real)?.ws;
    return { name: repo.name, path: repo.path, ...(workspace ? { workspace } : {}) };
  });
}

/**
 * The repos a sandboxed project run mounts (`Sandboxes.start`'s `repos`): each repo's link path and its workspace.
 * `missing`: the first repo without a workspace (the container could not see it); `repos` is then incomplete.
 */
export async function sandboxRepos(
  workspacesDir: string,
  home: ProjectHome,
): Promise<{ repos: { link: string; workspace: Workspace }[]; missing?: string }> {
  const repos: { link: string; workspace: Workspace }[] = [];
  for (const r of await projectRepos(workspacesDir, home)) {
    if (!r.workspace) return { repos, missing: r.name };
    repos.push({ link: r.path, workspace: r.workspace });
  }
  return { repos };
}
