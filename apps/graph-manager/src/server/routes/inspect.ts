import { readdir, stat } from "node:fs/promises";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";
import { insideWorkspace } from "./runs.js";

export interface WorkspaceInspection {
  branch: string;
  /** Lines of `git status --porcelain` outside `.graph-execution/`. */
  changes: number;
  tasksDir?: { exists: boolean; taskFiles: number };
  spec?: { exists: boolean };
}

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

async function git(ws: Workspace, args: string[]): Promise<string | undefined> {
  const res = await execa("git", args, { cwd: ws.path, env: gitEnv(), reject: false, stdin: "ignore" });
  return res.exitCode === 0 ? String(res.stdout ?? "") : undefined;
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
export async function inspectWorkspace(ws: Workspace, opts: { tasksDir?: string; spec?: string }): Promise<WorkspaceInspection> {
  // Status only, nothing is staged (as in pr.ts); graph-execution's own folder does not count.
  const [branch, status] = await Promise.all([
    // The branch, also before the first commit; a detached HEAD gives its short hash.
    git(ws, ["branch", "--show-current"]).then(async (b) => (b?.trim() ? b : git(ws, ["rev-parse", "--short", "HEAD"]))),
    git(ws, ["status", "--porcelain", "--", ".", ":(exclude).graph-execution"]),
  ]);
  const result: WorkspaceInspection = {
    branch: branch?.trim() ?? "",
    changes: (status ?? "").split("\n").filter((l) => l.trim() !== "").length,
  };
  if (opts.tasksDir !== undefined && opts.tasksDir !== "") {
    const full = insideWorkspace(ws, opts.tasksDir);
    const count = full ? await countTaskFiles(full) : undefined;
    result.tasksDir = count === undefined ? { exists: false, taskFiles: 0 } : { exists: true, taskFiles: count };
  }
  if (opts.spec !== undefined && opts.spec !== "") {
    const full = insideWorkspace(ws, opts.spec);
    result.spec = { exists: full !== undefined && (await isFile(full)) };
  }
  return result;
}

export async function inspectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { tasksDir?: string; spec?: string } }>("/api/workspaces/:id/inspect", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return inspectWorkspace(ws, { tasksDir: str(req.query.tasksDir), spec: str(req.query.spec) });
  });
}
