import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { liveRunIn } from "../liverun.js";
import { ForgeError, clientFor, connFor, gitAuthArgs, type ForgeKind, type ForgeRepo } from "../forges.js";
import { insideWorkspaces, listWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";

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

/** A background `git clone` started by `POST /api/workspaces`. */
export interface CloneJob {
  id: string;
  forge: ForgeKind;
  fullPath: string;
  status: "running" | "done" | "failed";
  /** 0..1: receiving objects counts for 0–0.9, resolving deltas for 0.9–1. */
  progress?: number;
  /** The last progress line of git, e.g. "Receiving objects: 58% (1204/2071)". */
  phase?: string;
  /** "clone failed: <git's last line>", token scrubbed. */
  error?: string;
  workspace?: WorkspaceEntry;
  startedAt: string;
  endedAt?: string;
}

/** Finished clone jobs stay listed this long. */
export const CLONE_JOB_TTL_MS = 10 * 60 * 1000;

/** Progress (0..1) from one line of `git clone --progress`, or undefined when the line has none. */
export function cloneProgressOf(line: string): number | undefined {
  const m = /(Receiving objects|Resolving deltas):\s+(\d{1,3})%/.exec(line);
  if (!m) return undefined;
  const pct = Math.min(100, Number(m[2])) / 100;
  return m[1] === "Receiving objects" ? pct * 0.9 : 0.9 + pct * 0.1;
}

const cloneBody = z.object({
  forge: z.enum(["github", "gitlab"]),
  fullPath: z.string().trim().min(1, "fullPath is required"),
});

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

function scrub(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("***");
}

/** Runs `git <args>` and calls `onLine` with each stderr line (split on \r and \n). Resolves with the exit code. */
function runGit(args: string[], onLine: (line: string) => void, track: (child: ChildProcess) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      env: { ...gitEnv, LC_ALL: "C" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    track(child);
    let rest = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const parts = (rest + chunk).split(/[\r\n]/);
      rest = parts.pop() ?? "";
      for (const p of parts) if (p.trim() !== "") onLine(p.trim());
    });
    child.on("error", (err) => {
      onLine(err.message);
      resolve(-1);
    });
    child.on("close", (code) => {
      if (rest.trim() !== "") onLine(rest.trim());
      resolve(code ?? -1);
    });
  });
}

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const root = ctx.config.workspacesDir;
  const jobs = new Map<string, CloneJob & { dest: string }>();
  const children = new Set<ChildProcess>();
  app.addHook("onClose", async () => {
    for (const c of children) c.kill("SIGKILL");
  });

  const publicJob = (job: CloneJob & { dest: string }): CloneJob => {
    const { dest, ...rest } = job;
    void dest;
    return rest;
  };
  /** Destinations claimed by a POST that is still looking up the repo (before its job exists). */
  const reserved = new Set<string>();
  const runningDests = () =>
    new Set([...reserved, ...[...jobs.values()].filter((j) => j.status === "running").map((j) => j.dest)]);
  const prune = () => {
    const now = Date.now();
    for (const [id, j] of jobs) if (j.endedAt && now - Date.parse(j.endedAt) > CLONE_JOB_TTL_MS) jobs.delete(id);
  };

  app.get("/api/workspaces", async () => {
    const busy = runningDests();
    const found = (await listWorkspaces(root)).filter((w) => !busy.has(w.path));
    const workspaces = await Promise.all(found.map(entryOf));
    return { workspaces, root };
  });

  app.get("/api/workspaces/clones", async () => {
    prune();
    return { jobs: [...jobs.values()].map(publicJob) };
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

    // Claim the destination before any await, so a second POST for the same repo gets 409 instead of racing.
    if (runningDests().has(dest)) return reply.code(409).send({ error: "already cloning" });
    if (existsSync(dest)) return reply.code(409).send({ error: "already cloned" });
    reserved.add(dest);
    let repo: ForgeRepo;
    let token: string;
    try {
      repo = await clientFor(ctx, forge).getRepo(body.fullPath);
      const conn = connFor(ctx, forge);
      if (!conn) throw new ForgeError(400, "not connected");
      token = conn.token;
    } catch (err) {
      reserved.delete(dest);
      throw err;
    }
    prune();
    const job: CloneJob & { dest: string } = {
      id: randomUUID(),
      forge,
      fullPath: body.fullPath,
      status: "running",
      startedAt: new Date().toISOString(),
      dest,
    };
    jobs.set(job.id, job);
    reserved.delete(dest);

    void (async () => {
      let last = "";
      // Only remove `dest` on failure when this job made it; never a folder something else put there.
      let ownsDest = false;
      const finish = (patch: Partial<CloneJob>) => Object.assign(job, patch, { endedAt: new Date().toISOString() });
      try {
        await mkdir(path.dirname(dest), { recursive: true });
        if (existsSync(dest)) {
          finish({ status: "failed", error: "clone failed: the destination already exists" });
          return;
        }
        ownsDest = true;
        const code = await runGit(
          [...gitAuthArgs(forge, token), "clone", "--progress", "--", repo.cloneUrl, dest],
          (line) => {
            const clean = scrub(line, token);
            last = clean;
            const p = cloneProgressOf(clean);
            if (p !== undefined) {
              job.progress = Math.max(job.progress ?? 0, p);
              job.phase = clean.replace(/^remote:\s*/, "");
            }
          },
          (child) => {
            children.add(child);
            child.on("close", () => children.delete(child));
          },
        );
        if (code !== 0) {
          if (ownsDest) await rm(dest, { recursive: true, force: true });
          finish({
            status: "failed",
            error: scrub(`clone failed: ${last || `git exited with code ${code}`}`, token),
          });
          return;
        }
        await mkdir(path.join(dest, ".git", "info"), { recursive: true });
        await appendFile(path.join(dest, ".git", "info", "exclude"), ".graph-execution/\n");
        const ws = resolveWorkspace(root, [forge, ...parts].join("~"));
        if (!ws) {
          finish({
            status: "failed",
            error: "clone failed: clone did not produce a workspace",
          });
          return;
        }
        const workspace = await entryOf(ws);
        finish({ status: "done", progress: 1, workspace });
      } catch (err) {
        if (ownsDest) await rm(dest, { recursive: true, force: true }).catch(() => {});
        finish({
          status: "failed",
          error: scrub(`clone failed: ${(err as Error).message}`, token),
        });
      }
    })();

    return reply.code(202).send({ job: publicJob(job) });
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (req, reply) => {
    const ws = resolveWorkspace(root, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const project = ctx.store.projects().find((x) => x.workspaces.includes(ws.id));
    if (project) return reply.code(409).send({ error: `workspace is part of project ${project.name}` });
    if (await liveRunIn(ctx, ws)) return reply.code(409).send({ error: "a run is live in this workspace" });
    for (const t of ctx.terminals.list()) {
      if (t.workspaceId === ws.id || path.resolve(t.cwd) === ws.path || insideWorkspaces(ws.path, t.cwd)) ctx.terminals.remove(t.id);
    }
    await rm(ws.path, { recursive: true, force: true });
    return reply.code(204).send();
  });
}
