import { existsSync } from "node:fs";
import { execa } from "execa";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Data as AppData } from "../store.js";
import { AGENT_IDS, AGENTS, AgentPrepareError, commandLine, getAgent, isInstalled, prepareProjectConfig, type PrepareResult } from "../agents.js";
import { PROJECT_FILE, projectDirOf, type Project } from "../projects.js";
import { batchOutput } from "../output-batch.js";
import { TerminalRunningError } from "../terminals.js";
import { insideWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";
import { addTerminalWorktree, hasWork, removeWorktree, worktreeState, type TerminalWorktree } from "../worktrees.js";

const createBody = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    cols: z.number().int().min(2).max(1000).optional(),
    rows: z.number().int().min(2).max(1000).optional(),
    agent: z.enum(AGENT_IDS).optional(),
    /** Reopen a kept worktree of the workspace instead of making a new one. */
    worktreeId: z.string().min(1).optional(),
  })
  .strict();

const deleteQuery = z.object({ worktree: z.enum(["delete", "keep"]).optional() });

const patchBody = z.object({ title: z.string().trim().min(1).max(200) }).strict();

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
  // The client measures its round trip to the server (shown under the terminal); `t` comes back as sent.
  z.object({ type: z.literal("ping"), t: z.number() }),
]);

export async function terminalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { terminals, config } = ctx;
  const root = path.resolve(config.workspacesDir);

  app.get("/api/terminals", async () => ({ terminals: terminals.list() }));

  app.get("/api/agents", async () => ({
    agents: AGENTS.map((a) => ({ id: a.id, label: a.label, binary: a.binary, installed: isInstalled(a), connect: a.connect })),
  }));

  app.post("/api/terminals", async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    let cwd: string;
    let workspaceId: string | undefined;
    let ws: Workspace | undefined;
    let project: Project | undefined;
    let worktree: TerminalWorktree | undefined;
    let reopened = false;
    if (body.worktreeId !== undefined && body.workspaceId === undefined) {
      return reply.code(400).send({ error: "worktreeId needs its workspaceId" });
    }
    if (body.workspaceId !== undefined && body.projectId !== undefined) {
      return reply.code(400).send({ error: "pass workspaceId or projectId, not both" });
    }
    if (body.projectId !== undefined) {
      project = ctx.store.project(body.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      cwd = projectDirOf(config.workspacesDir, project.id);
      if (!existsSync(path.join(cwd, PROJECT_FILE))) return reply.code(404).send({ error: "project folder is missing" });
    } else if (body.workspaceId !== undefined) {
      ws = resolveWorkspace(root, body.workspaceId);
      if (!ws) return reply.code(404).send({ error: "workspace not found" });
      cwd = ws.path;
      workspaceId = ws.id;
      // Its own worktree and branch (KAN-100): terminals and runs never share a folder. A workspace without a commit
      // yet cannot have one; that terminal works in the checkout, as before.
      if (body.worktreeId !== undefined) {
        const rec = ctx.store.get().terminalWorktrees[body.worktreeId];
        const open = rec?.terminalId !== undefined && terminals.get(rec.terminalId) !== undefined && !rec.kept;
        if (!rec || rec.workspaceId !== ws.id || !existsSync(rec.path)) return reply.code(404).send({ error: "worktree not found" });
        if (open) return reply.code(409).send({ error: "the worktree is open in another terminal" });
        worktree = { id: body.worktreeId, path: rec.path, branch: rec.branch, base: rec.base, ...(rec.baseBranch ? { baseBranch: rec.baseBranch } : {}) };
        reopened = true;
      } else worktree = await addTerminalWorktree(ws.path);
      if (worktree) cwd = worktree.path;
    } else {
      cwd = path.resolve(body.cwd ?? root);
      if (cwd !== root && !insideWorkspaces(root, cwd)) return reply.code(400).send({ error: "cwd must be inside the workspaces folder" });
    }
    // GM_PROJECT_ID: which project the terminal is on, for the tools started in it.
    const projectEnv = project ? { GM_PROJECT_ID: project.id } : undefined;
    const adapter = body.agent !== undefined ? getAgent(body.agent) : undefined;
    const wt = worktree ? { id: worktree.id, path: worktree.path, branch: worktree.branch } : undefined;
    if (!adapter) {
      const info = terminals.create({
        cwd,
        workspaceId,
        projectId: project?.id,
        title: body.title?.trim() || project?.name,
        cols: body.cols,
        rows: body.rows,
        env: projectEnv,
        worktree: wt,
      });
      if (worktree && ws) await saveWorktree(ctx, ws, worktree, info.id, info.title);
      return reply.code(201).send(info);
    }
    if (!isInstalled(adapter)) {
      if (worktree && ws && !reopened) await removeWorktree(ws.path, worktree.path, worktree.branch);
      return reply.code(400).send({ error: `${adapter.binary} is not installed` });
    }
    let connected: PrepareResult | undefined;
    if (adapter.connect === "project-config") {
      if (!ws && !project) return reply.code(400).send({ error: `${adapter.label} needs a workspace` });
      try {
        // On a project the file goes into the project folder's own repo, never into a workspace.
        // In the terminal's worktree when it has one: that is where the agent reads its config.
        connected = await prepareProjectConfig(adapter, worktree ? { path: worktree.path } : (ws ?? { path: cwd }));
      } catch (err) {
        if (worktree && ws && !reopened) await removeWorktree(ws.path, worktree.path, worktree.branch);
        if (err instanceof AgentPrepareError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
      // The config commit is graph-manager's own, not the user's work: the worktree's base moves past it.
      if (worktree && connected.changed) {
        const head = await execa("git", ["rev-parse", "HEAD"], { cwd: worktree.path, reject: false });
        if (head.exitCode === 0) worktree.base = String(head.stdout).trim();
      }
    }
    const launch = adapter.launch({ dataDir: config.dataDir });
    const repo = project?.name ?? workspaceId?.split("~").pop();
    const info = terminals.create({
      cwd,
      workspaceId,
      projectId: project?.id,
      title: body.title?.trim() || (repo ? `${adapter.label} · ${repo}` : adapter.label),
      cols: body.cols,
      rows: body.rows,
      agent: adapter.id,
      env: { ...launch.env, ...projectEnv },
      input: commandLine(launch.argv) + "\r",
      worktree: wt,
    });
    if (worktree && ws) await saveWorktree(ctx, ws, worktree, info.id, info.title);
    return reply.code(201).send(connected ? { ...info, connected } : info);
  });

  // Closing a terminal (KAN-100): its worktree goes with it when it holds no work; with work, the user chooses.
  app.delete<{ Params: { id: string }; Querystring: { worktree?: string } }>("/api/terminals/:id", async (req, reply) => {
    const id = req.params.id;
    const info = terminals.get(id);
    if (!info) return reply.code(404).send({ error: "terminal not found" });
    const { worktree: choice } = deleteQuery.parse(req.query ?? {});
    const entry = worktreeOfTerminal(ctx, id);
    if (entry) {
      const [wid, rec] = entry;
      const ws = resolveWorkspace(root, rec.workspaceId);
      const state = ws ? await worktreeState(rec.path, rec.base) : { dirty: 0, ahead: 0 };
      if (choice === undefined && ws && hasWork(state)) {
        return reply.code(409).send({ error: "the terminal has work", needsChoice: true, ...state, branch: rec.branch, worktreeId: wid });
      }
      terminals.remove(id);
      if (choice === "keep") {
        await ctx.store.update((d) => {
          const r = d.terminalWorktrees[wid];
          if (r) {
            delete r.terminalId;
            r.kept = true;
          }
        });
      } else {
        if (ws) await removeWorktree(ws.path, rec.path, rec.branch);
        await ctx.store.update((d) => {
          delete d.terminalWorktrees[wid];
        });
      }
      return reply.code(204).send();
    }
    terminals.remove(id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/terminals/:id/restart", async (req, reply) => {
    try {
      const info = terminals.restart(req.params.id);
      if (!info) return reply.code(404).send({ error: "terminal not found" });
      return info;
    } catch (err) {
      if (err instanceof TerminalRunningError) return reply.code(409).send({ error: "the terminal is still running" });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    const body = patchBody.parse(req.body ?? {});
    const info = terminals.rename(req.params.id, body.title);
    if (!info) return reply.code(404).send({ error: "terminal not found" });
    return info;
  });

  app.get<{ Params: { id: string } }>("/api/terminals/:id/ws", { websocket: true }, (socket, req) => {
    const id = req.params.id;
    if (!terminals.get(id)) {
      socket.close(4404, "terminal not found");
      return;
    }
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    // One frame per PTY chunk floods the socket during a TUI redraw; batch them (see batchOutput).
    const output = batchOutput((data) => send({ type: "data", data }));
    const att = terminals.attach(
      id,
      (data) => output.push(data),
      (code) => {
        output.flush();
        send({ type: "exit", code });
      },
      () => {
        output.flush();
        send({ type: "restart" });
      },
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
      else if (msg.data.type === "ping") send({ type: "pong", t: msg.data.t });
      else att.resize(msg.data.cols, msg.data.rows);
    });
    socket.on("close", () => {
      output.dispose();
      att.detach();
    });
  });
}

/** The stored worktree of an open terminal, with its id. */
export function worktreeOfTerminal(ctx: AppContext, terminalId: string): [string, AppData["terminalWorktrees"][string]] | undefined {
  return Object.entries(ctx.store.get().terminalWorktrees).find(([, r]) => r.terminalId === terminalId && !r.kept);
}

async function saveWorktree(ctx: AppContext, ws: Workspace, wt: TerminalWorktree, terminalId: string, title: string): Promise<void> {
  await ctx.store.update((d) => {
    const old = d.terminalWorktrees[wt.id];
    d.terminalWorktrees[wt.id] = {
      ...(old ? { createdAt: old.createdAt } : {}),
      workspaceId: ws.id,
      path: wt.path,
      branch: wt.branch,
      base: wt.base,
      ...(wt.baseBranch ? { baseBranch: wt.baseBranch } : {}),
      title: old?.title ?? title,
      createdAt: old?.createdAt ?? new Date().toISOString(),
      terminalId,
    };
  });
}

/** The worktrees of a workspace that no open terminal uses: kept on close, or left from before a restart. */
export function keptWorktrees(ctx: AppContext, workspaceId: string): [string, AppData["terminalWorktrees"][string]][] {
  return Object.entries(ctx.store.get().terminalWorktrees).filter(
    ([, r]) => r.workspaceId === workspaceId && (r.kept || r.terminalId === undefined || ctx.terminals.get(r.terminalId) === undefined),
  );
}

export async function keptWorktreeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const root = path.resolve(ctx.config.workspacesDir);

  // Every kept worktree, for the Terminals sidebar.
  app.get("/api/worktrees", async () => {
    const ids = new Set(Object.values(ctx.store.get().terminalWorktrees).map((r) => r.workspaceId));
    const all = await Promise.all(
      [...ids].map(async (wsId) =>
        resolveWorkspace(root, wsId)
          ? Promise.all(
              keptWorktrees(ctx, wsId)
                .filter(([, r]) => existsSync(r.path))
                .map(async ([id, r]) => ({ id, workspaceId: wsId, path: r.path, branch: r.branch, title: r.title, createdAt: r.createdAt, ...(await worktreeState(r.path, r.base)) })),
            )
          : [],
      ),
    );
    return { worktrees: all.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/worktrees", async (req, reply) => {
    const ws = resolveWorkspace(root, req.params.id);
    if (!ws) return reply.code(404).send({ error: "workspace not found" });
    const list = await Promise.all(
      keptWorktrees(ctx, ws.id)
        .filter(([, r]) => existsSync(r.path))
        .map(async ([id, r]) => ({ id, path: r.path, branch: r.branch, title: r.title, createdAt: r.createdAt, ...(await worktreeState(r.path, r.base)) })),
    );
    return { worktrees: list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  });

  app.delete<{ Params: { id: string; wid: string } }>("/api/workspaces/:id/worktrees/:wid", async (req, reply) => {
    const ws = resolveWorkspace(root, req.params.id);
    if (!ws) return reply.code(404).send({ error: "workspace not found" });
    const found = keptWorktrees(ctx, ws.id).find(([id]) => id === req.params.wid);
    if (!found) return reply.code(404).send({ error: "worktree not found" });
    const [, rec] = found;
    await removeWorktree(ws.path, rec.path, rec.branch);
    await ctx.store.update((d) => {
      delete d.terminalWorktrees[req.params.wid];
    });
    return reply.code(204).send();
  });
}
