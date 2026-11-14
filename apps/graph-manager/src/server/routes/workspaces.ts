// `GET /api/workspaces`: the clones on this machine the user may use (the agents' tools and `/api/v1` read it). Repositories
// are cloned by a repo session (`POST /api/sessions`, docs/prd/hosted-sessions.md); there is no clone or delete route.
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { listWorkspaces, type Workspace } from "../workspaces.js";

export interface WorkspaceEntry {
  id: string;
  forge: string;
  fullPath: string;
  path: string;
  branch: string;
  dirty: boolean;
  /** Lines of `git status --porcelain`, without `.graph-execution/`. */
  changes: number;
  remoteUrl: string;
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa("git", ["-C", cwd, ...args], {
      env: gitEnv,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Removes `user:pass@` from an URL; leaves other text alone. */
export function stripCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return url;
  } catch {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  }
}

async function entryOf(ws: Workspace): Promise<WorkspaceEntry> {
  const [branch, status, remote] = await Promise.all([
    git(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(ws.path, ["status", "--porcelain", "--", ".", ":(exclude).graph-execution"]),
    git(ws.path, ["remote", "get-url", "origin"]),
  ]);
  const changes = status === "" ? 0 : status.split("\n").filter((l) => l.trim() !== "").length;
  return {
    id: ws.id,
    forge: ws.forge,
    fullPath: ws.fullPath,
    path: ws.path,
    branch,
    dirty: changes > 0,
    changes,
    remoteUrl: stripCredentials(remote),
  };
}

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const root = ctx.config.workspacesDir;

  app.get("/api/workspaces", async (req) => {
    const found = [];
    for (const w of await listWorkspaces(root)) if (await ctx.sessions.ownsWorkspace(req.user, w.id)) found.push(w);
    const workspaces = await Promise.all(found.map(entryOf));
    return { workspaces, root };
  });
}
