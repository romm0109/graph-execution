import { REVIEWERS_ENV } from "graph-execution/api";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { AGENT_IDS, AGENTS, AgentPrepareError, commandLine, getAgent, isInstalled, prepareProjectConfig, type AgentId, type PrepareResult } from "../agents.js";
import type { WorkspaceHost } from "../host/types.js";
import type { User } from "../identity.js";
import { PROJECT_FILE, projectDirOf, type Project } from "../projects.js";
import { projectOf } from "../store.js";
import { agentKeyEnv } from "../sessions/logins.js";
import { userReviewersFile } from "../reviewers.js";
import { workspaceHostOf } from "./specs.js";
import { TerminalRunningError, type CreateTerminal, type TerminalInfo } from "../terminals.js";
import { insideWorkspaces } from "../workspaces.js";

const createBody = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    cols: z.number().int().min(2).max(1000).optional(),
    rows: z.number().int().min(2).max(1000).optional(),
    agent: z.enum(AGENT_IDS).optional(),
  })
  .strict();

const patchBody = z.object({ title: z.string().trim().min(1).max(200) }).strict();

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
]);

export async function terminalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { terminals, config } = ctx;
  const root = path.resolve(config.workspacesDir);

  app.get("/api/terminals", async (req) => ({ terminals: terminals.listFor(req.user.id) }));
  /** The terminal when it is the user's; another user's answers like an unknown one. */
  const mine = (id: string, user: User): TerminalInfo | undefined => {
    const t = terminals.get(id);
    return t && t.userId === user.id ? t : undefined;
  };

  app.get("/api/agents", async () => ({
    agents: AGENTS.map((a) => ({ id: a.id, label: a.label, binary: a.binary, installed: isInstalled(a), connect: a.connect })),
  }));

  app.post("/api/terminals", async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    let cwd: string;
    let workspaceId: string | undefined;
    let host: WorkspaceHost | undefined;
    let project: Project | undefined;
    if (body.workspaceId !== undefined && body.projectId !== undefined) {
      return reply.code(400).send({ error: "pass workspaceId or projectId, not both" });
    }
    if (body.projectId !== undefined) {
      project = projectOf((await ctx.store.forUser(req.user)).get(), body.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      cwd = projectDirOf(config.workspacesDir, project.id);
      if (!existsSync(path.join(cwd, PROJECT_FILE))) return reply.code(404).send({ error: "project folder is missing" });
    } else if (body.workspaceId !== undefined) {
      // Through the user's session host: a Docker or hosted session's clone is in its container, not on this disk.
      const found = await workspaceHostOf(ctx, req.user, body.workspaceId);
      if (!found) return reply.code(404).send({ error: "workspace not found" });
      workspaceId = body.workspaceId;
      host = found.host;
      cwd = found.ws?.path ?? path.join(root, ...body.workspaceId.split("~"));
    } else {
      cwd = path.resolve(body.cwd ?? root);
      if (cwd !== root && !insideWorkspaces(root, cwd)) return reply.code(400).send({ error: "cwd must be inside the workspaces folder" });
    }
    // A workspace terminal is spawned by the workspace's host; project and cwd terminals stay on this server.
    const info = await openTerminal(ctx, req.user, {
      host,
      workspaceId,
      cwd,
      project,
      agent: body.agent,
      title: body.title,
      cols: body.cols,
      rows: body.rows,
    });
    return reply.code(201).send(info);
  });

  app.delete<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    const t = mine(req.params.id, req.user);
    if (!t || !terminals.remove(t.id)) return reply.code(404).send({ error: "terminal not found" });
    if (t.sessionId !== undefined) {
      ctx.sessions.touch(t.sessionId);
      if (ctx.sessions.terminalIds(req.user, t.sessionId).length === 0) {
        const res = await ctx.sessions.lastTerminalClosed(req.user, t.sessionId);
        if (res.ask) return reply.code(200).send({ sessionId: t.sessionId, ask: res.ask });
      }
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/terminals/:id/restart", async (req, reply) => {
    if (!mine(req.params.id, req.user)) return reply.code(404).send({ error: "terminal not found" });
    try {
      const info = await terminals.restartAsync(req.params.id);
      if (!info) return reply.code(404).send({ error: "terminal not found" });
      return info;
    } catch (err) {
      if (err instanceof TerminalRunningError) return reply.code(409).send({ error: "the terminal is still running" });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    const body = patchBody.parse(req.body ?? {});
    if (!mine(req.params.id, req.user)) return reply.code(404).send({ error: "terminal not found" });
    const info = terminals.rename(req.params.id, body.title);
    if (!info) return reply.code(404).send({ error: "terminal not found" });
    return info;
  });

  app.get<{ Params: { id: string } }>("/api/terminals/:id/ws", { websocket: true }, (socket, req) => {
    const id = req.params.id;
    if (!mine(id, req.user)) {
      socket.close(4404, "terminal not found");
      return;
    }
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const att = terminals.attach(
      id,
      (data) => send({ type: "data", data }),
      (code) => send({ type: "exit", code }),
      () => send({ type: "restart" }),
    );
    send({ type: "replay", data: att.replay });
    socket.on("message", (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = clientMessage.safeParse(parsed);
      if (!msg.success) return;
      if (msg.data.type === "input") att.write(msg.data.data);
      else att.resize(msg.data.cols, msg.data.rows);
    });
    socket.on("close", () => att.detach());
  });
}

/** A request error with an HTTP status (the app's error handler answers `{ error: message }`). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenTerminal {
  /** Spawns the terminal in `workspaceId` (required with it); without one the terminal runs on this server in `cwd`. */
  host?: WorkspaceHost;
  workspaceId?: string;
  /** The folder shown (and the cwd of a terminal on this server). */
  cwd: string;
  /** A project terminal (cwd = the project folder). */
  project?: Project;
  agent?: AgentId;
  title?: string;
  cols?: number;
  rows?: number;
  sessionId?: string;
  env?: Record<string, string>;
}

/**
 * Opens a shell, or an agent when `p.agent` is set, for `user`. Throws `HttpError(400, "<binary> is not installed")`
 * for a missing agent.
 */
export async function openTerminal(ctx: AppContext, user: User, p: OpenTerminal): Promise<TerminalInfo & { connected?: PrepareResult }> {
  const { terminals } = ctx;
  const project = p.project;
  // GM_PROJECT_ID: which project the terminal is on, for the tools started in it.
  // The user's saved agent keys (Settings → Agents) first: a session's own env (the same keys) and launch env win.
  // A terminal on this server gets the user's own reviewers file (a container's agent has no access to it).
  const local = !p.host || p.host === ctx.localHost;
  const reviewers: Record<string, string> = local ? { [REVIEWERS_ENV]: await userReviewersFile(ctx.config.dataDir, user, await ctx.store.forUser(user)) } : {};
  const baseEnv = { ...reviewers, ...(await agentKeyEnv(ctx.store, user)), ...p.env, ...(project ? { GM_PROJECT_ID: project.id } : {}) };
  const env = Object.keys(baseEnv).length > 0 ? baseEnv : undefined;
  const open = async (c: CreateTerminal): Promise<TerminalInfo> => {
    const full = { ...c, userId: user.id, ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}) };
    return p.host && p.workspaceId !== undefined ? terminals.createOnHost(p.host, { ...full, workspaceId: p.workspaceId }) : terminals.create(full);
  };
  const adapter = p.agent !== undefined ? getAgent(p.agent) : undefined;
  if (!adapter) {
    return open({ cwd: p.cwd, workspaceId: p.workspaceId, projectId: project?.id, title: p.title?.trim() || project?.name, cols: p.cols, rows: p.rows, env });
  }
  if (!isInstalled(adapter)) throw new HttpError(400, `${adapter.binary} is not installed`);
  let connected: PrepareResult | undefined;
  if (adapter.connect === "project-config") {
    if (p.workspaceId === undefined && !project) throw new HttpError(400, `${adapter.label} needs a workspace`);
    try {
      // On a project the file goes into the project folder's own repo, never into a workspace.
      connected = await prepareProjectConfig(adapter, { path: p.cwd });
    } catch (err) {
      if (err instanceof AgentPrepareError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }
  const launch = adapter.launch({ dataDir: ctx.config.dataDir });
  const repo = project?.name ?? p.workspaceId?.split("~").pop();
  const info = await open({
    cwd: p.cwd,
    workspaceId: p.workspaceId,
    projectId: project?.id,
    title: p.title?.trim() || (repo ? `${adapter.label} · ${repo}` : adapter.label),
    cols: p.cols,
    rows: p.rows,
    agent: adapter.id,
    env: { ...launch.env, ...env },
    input: commandLine(launch.argv) + "\r",
  });
  return connected ? { ...info, connected } : info;
}
