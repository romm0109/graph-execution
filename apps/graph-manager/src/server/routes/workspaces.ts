import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { ForgeError, clientFor, connFor, gitAuthArgs, type ForgeKind } from "../forges.js";
import { insideWorkspaces, listWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";

export interface WorkspaceEntry {
  id: string;
  forge: string;
  fullPath: string;
  path: string;
  branch: string;
  dirty: boolean;
  remoteUrl: string;
}

const cloneBody = z.object({
  forge: z.enum(["github", "gitlab"]),
  fullPath: z.string().trim().min(1, "fullPath is required"),
});

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa("git", ["-C", cwd, ...args], { env: gitEnv });
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
    git(ws.path, ["status", "--porcelain"]),
    git(ws.path, ["remote", "get-url", "origin"]),
  ]);
  return { id: ws.id, forge: ws.forge, fullPath: ws.fullPath, path: ws.path, branch, dirty: status !== "", remoteUrl: stripCredentials(remote) };
}

/** The pid of a live run in `wsPath/.graph-execution/<run>/lock`, if any. */
async function liveRunPid(wsPath: string): Promise<number | undefined> {
  const runsDir = path.join(wsPath, ".graph-execution");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const text = await readFile(path.join(runsDir, e.name, "lock"), "utf8").catch(() => "");
    const pid = Number.parseInt(text.split("\n", 1)[0]?.trim() ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return pid;
    }
  }
  return undefined;
}

function scrub(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("***");
}

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const root = ctx.config.workspacesDir;

  app.get("/api/workspaces", async () => {
    const workspaces = await Promise.all((await listWorkspaces(root)).map(entryOf));
    return { workspaces };
  });

  app.post("/api/workspaces", async (req, reply) => {
    const body = cloneBody.parse(req.body);
    const forge: ForgeKind = body.forge;
    const parts = body.fullPath.split("/");
    if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".") || p.includes("\\") || p.includes("\0") || p.includes("~"))) {
      return reply.code(400).send({ error: "invalid fullPath" });
    }
    const dest = path.join(root, forge, ...parts);
    if (!insideWorkspaces(root, dest)) return reply.code(400).send({ error: "invalid fullPath" });

    const repo = await clientFor(ctx, forge).getRepo(body.fullPath);
    if (existsSync(dest)) return reply.code(409).send({ error: "already cloned" });

    const conn = connFor(ctx, forge);
    if (!conn) throw new ForgeError(400, "not connected");
    const token = conn.token;
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await execa("git", [...gitAuthArgs(forge, token), "clone", "--", repo.cloneUrl, dest], { env: gitEnv });
    } catch (err) {
      await rm(dest, { recursive: true, force: true });
      const stderr = String((err as { stderr?: unknown }).stderr ?? (err as Error).message ?? "");
      const last = stderr.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "unknown error";
      return reply.code(502).send({ error: scrub(`git clone failed: ${last.trim()}`, token) });
    }
    await mkdir(path.join(dest, ".git", "info"), { recursive: true });
    await appendFile(path.join(dest, ".git", "info", "exclude"), ".graph-execution/\n");
    const ws = resolveWorkspace(root, [forge, ...parts].join("~"));
    if (!ws) return reply.code(500).send({ error: "clone did not produce a workspace" });
    return reply.code(201).send(await entryOf(ws));
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (req, reply) => {
    const ws = resolveWorkspace(root, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    if ((await liveRunPid(ws.path)) !== undefined) return reply.code(409).send({ error: "a run is live in this workspace" });
    for (const t of ctx.terminals.list()) {
      if (t.workspaceId === ws.id || path.resolve(t.cwd) === ws.path || insideWorkspaces(ws.path, t.cwd)) ctx.terminals.remove(t.id);
    }
    await rm(ws.path, { recursive: true, force: true });
    return reply.code(204).send();
  });
}
