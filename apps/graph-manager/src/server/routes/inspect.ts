import { readdir, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import path from "node:path";
import { PROJECT_PREFIX, projectRepos, resolveRunHome, type ProjectHome } from "../runhome.js";
import type { WorkspaceHost } from "../host/types.js";
import { resolveWorkspace } from "../workspaces.js";

export interface WorkspaceInspection {
  branch: string;
  /** Lines of `git status --porcelain` outside `.graph-execution/`. */
  changes: number;
  tasksDir?: { exists: boolean; taskFiles: number };
  spec?: { exists: boolean };
  /** The workspace's session runs remotely: each run gets its own container, from the last pushed commit. */
  hosted?: boolean;
  /** With `hosted`: the session's repository, `<owner>/<name>`. */
  repo?: string;
}

/** The task files of a folder: `*.json` directly in it, except `test-plan.json`; undefined when it is not a folder. */
async function countTaskFiles(dir: string): Promise<number | undefined> {
  try {
    if (!(await stat(dir)).isDirectory()) return undefined;
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== "test-plan.json").length;
  } catch {
    return undefined;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** What the Start run drawer shows about a workspace: its branch, uncommitted files, and the chosen paths. */
export async function inspectWorkspace(host: WorkspaceHost, wsId: string, opts: { tasksDir?: string; spec?: string }): Promise<WorkspaceInspection> {
  const git = async (args: string[]): Promise<string | undefined> => {
    const res = await host.git(wsId, args);
    return res.exitCode === 0 ? res.stdout : undefined;
  };
  // Status only, nothing is staged (as in pr.ts); graph-execution's own folder does not count.
  const [branch, status] = await Promise.all([
    // The branch, also before the first commit; a detached HEAD gives its short hash.
    git(["branch", "--show-current"]).then(async (b) => (b?.trim() ? b : git(["rev-parse", "--short", "HEAD"]))),
    git(["status", "--porcelain", "--", ".", ":(exclude).graph-execution"]),
  ]);
  const result: WorkspaceInspection = {
    branch: branch?.trim() ?? "",
    changes: (status ?? "").split("\n").filter((l) => l.trim() !== "").length,
  };
  if (opts.tasksDir !== undefined && opts.tasksDir !== "") {
    const st = await host.stat(wsId, opts.tasksDir);
    if (st?.kind !== "dir") result.tasksDir = { exists: false, taskFiles: 0 };
    else {
      const files = await host.listFiles(wsId, opts.tasksDir, { glob: "*.json" });
      result.tasksDir = { exists: true, taskFiles: files.filter((f) => f !== "test-plan.json").length };
    }
  }
  if (opts.spec !== undefined && opts.spec !== "") {
    result.spec = { exists: (await host.stat(wsId, opts.spec))?.kind === "file" };
  }
  return result;
}

/** What the Start run drawer shows about a project: per repo its spec and tasks, plus the contract and the test plan. */
export interface ProjectInspection {
  id: string;
  name: string;
  /** `contract.md` is a file. */
  contract: boolean;
  /** `test-plan.json` is a file. */
  testPlan: boolean;
  repos: {
    name: string;
    workspaceId?: string;
    fullPath?: string;
    branch?: string;
    changes?: number;
    /** `specs/<name>.md` is a file. */
    spec: boolean;
    /** Task files in `tasks/<name>/`; absent when there is no such folder (the repo is left unchanged). */
    taskFiles?: number;
  }[];
}

export async function inspectProject(
  workspacesDir: string,
  home: ProjectHome,
  hostOf: (workspaceId: string) => Promise<WorkspaceHost>,
): Promise<ProjectInspection> {
  const repos = await Promise.all(
    (await projectRepos(workspacesDir, home)).map(async (repo) => {
      const row: ProjectInspection["repos"][number] = { name: repo.name, spec: await isFile(path.join(home.path, "specs", `${repo.name}.md`)) };
      if (repo.workspace) {
        const ws = await inspectWorkspace(await hostOf(repo.workspace.id), repo.workspace.id, {});
        Object.assign(row, { workspaceId: repo.workspace.id, fullPath: repo.workspace.fullPath, branch: ws.branch, changes: ws.changes });
      }
      const taskFiles = await countTaskFiles(path.join(home.path, "tasks", repo.name));
      if (taskFiles !== undefined) row.taskFiles = taskFiles;
      return row;
    }),
  );
  return {
    id: home.project.id,
    name: home.project.name,
    contract: await isFile(path.join(home.path, "contract.md")),
    testPlan: await isFile(path.join(home.path, "test-plan.json")),
    repos,
  };
}

export async function inspectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/projects/:id/inspect", async (req, reply) => {
    const home = resolveRunHome(ctx.config.workspacesDir, await ctx.store.forUser(req.user), `${PROJECT_PREFIX}${req.params.id}`);
    if (home?.kind !== "project") return reply.code(404).send({ error: "unknown project" });
    return inspectProject(ctx.config.workspacesDir, home, (id) => ctx.hostFor(id, req.user));
  });

  app.get<{ Params: { id: string }; Querystring: { tasksDir?: string; spec?: string } }>("/api/workspaces/:id/inspect", async (req, reply) => {
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const opts = { tasksDir: str(req.query.tasksDir), spec: str(req.query.spec) };
    // A remote session's clone is not on this server: ask its host.
    const us = await ctx.store.forUser(req.user);
    const session = Object.values(us.get().sessions).find((s) => s.workspaceId === req.params.id && s.state !== "starting");
    if (session) {
      const host = await ctx.hostFor(req.params.id, req.user);
      if (host.kind === "remote") {
        return { ...(await inspectWorkspace(host, req.params.id, opts)), hosted: true, repo: `${session.repo.owner}/${session.repo.name}` };
      }
    }
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return inspectWorkspace(await ctx.hostFor(ws.id, req.user), ws.id, opts);
  });
}
