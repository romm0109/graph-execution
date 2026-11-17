import { existsSync } from "node:fs";
import { execa } from "execa";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { PrError } from "../pr.js";
import { currentWorktreeJob, startWorktreePr, worktreePrKey } from "../worktree-pr.js";
import { currentProjectWorktreeJob, projectWorktreePrKey, startProjectWorktreePr } from "../project-worktree-pr.js";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Data as AppData, ProjectWorktreeRecord } from "../store.js";
import { AGENT_IDS, AGENTS, AgentPrepareError, commandLine, getAgent, isInstalled, prepareProjectConfig, type PrepareResult } from "../agents.js";
import { PROJECT_FILE, projectDirOf, type Project } from "../projects.js";
import { batchOutput } from "../output-batch.js";
import { TerminalRunningError } from "../terminals.js";
import { insideWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";
import { projectHome, projectRepos } from "../runhome.js";
import {
  addProjectWorktrees,
  addTerminalWorktree,
  baseBranches,
  type BaseBranches,
  defaultBaseBranch,
  hasWork,
  projectHasWork,
  projectWorktreeState,
  removeProjectWorktrees,
  removeWorktree,
  WorktreeError,
  worktreeState,
  newWorktreeId,
  type ProjectWorktrees,
  type TerminalWorktree,
} from "../worktrees.js";

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
    /** Reopen a kept worktree set of the project instead of making a new one. */
    projectWorktreeId: z.string().min(1).optional(),
    /** The branch a new worktree is cut from (after fetching it from origin); default: the remote default branch. */
    base: z.string().trim().min(1).optional(),
    /** On a project: the base branch of each repo's worktree, by repo name; default: each workspace's default branch. */
    bases: z.record(z.string(), z.string().trim().min(1)).optional(),
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

/** The branches a terminal worktree of `ws` can be cut from (`GET /api/workspaces/:id/branches`, `GET /api/projects/:id/branches`). */
export async function branchInfo(ctx: AppContext, ws: Workspace, opts: { fetch: boolean }): Promise<BaseBranches | { branches: string[]; noCommit: true }> {
  const res = await baseBranches(ctx, ws, opts.fetch);
  return res.noCommit ? { branches: [], noCommit: true } : res;
}

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
    if (body.projectWorktreeId !== undefined && body.projectId === undefined) {
      return reply.code(400).send({ error: "projectWorktreeId needs its projectId" });
    }
    if (body.workspaceId !== undefined && body.projectId !== undefined) {
      return reply.code(400).send({ error: "pass workspaceId or projectId, not both" });
    }
    if (body.base !== undefined && body.workspaceId === undefined) return reply.code(400).send({ error: "base needs a workspaceId" });
    if (body.bases !== undefined && body.projectId === undefined) return reply.code(400).send({ error: "bases needs a projectId" });
    let projectRepoList: { name: string; workspace: Workspace; baseBranch?: string }[] | undefined;
    let projectWt: (ProjectWorktrees & { id: string }) | undefined;
    let projectReopened = false;
    if (body.projectId !== undefined) {
      project = ctx.store.project(body.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      cwd = projectDirOf(config.workspacesDir, project.id);
      if (!existsSync(path.join(cwd, PROJECT_FILE))) return reply.code(404).send({ error: "project folder is missing" });
      if (body.projectWorktreeId !== undefined) {
        // A kept project worktree set: the terminal starts in it again, with no new worktrees.
        const rec = ctx.store.get().projectWorktrees[body.projectWorktreeId];
        const open = rec?.terminalId !== undefined && terminals.get(rec.terminalId) !== undefined && !rec.kept;
        if (!rec || rec.projectId !== project.id || !existsSync(rec.path)) return reply.code(404).send({ error: "worktree not found" });
        const missing = rec.repos.find((r) => r.isolated && !existsSync(r.path));
        if (missing) return reply.code(404).send({ error: `repo ${missing.name}'s worktree is missing` });
        if (open) return reply.code(409).send({ error: "the worktree is open in another terminal" });
        projectWt = { id: body.projectWorktreeId, path: rec.path, branch: rec.branch, base: rec.base, repos: rec.repos, warnings: [] };
        projectReopened = true;
        cwd = rec.path;
      }
      // Its own worktrees (docs/prd/project-terminal-worktrees.md): of the project repo, and of each repo it links.
      const home = projectReopened ? undefined : projectHome(config.workspacesDir, project.id, ctx.store.get().projects[project.id]);
      if (home) {
        const repos = await projectRepos(config.workspacesDir, home);
        const names = new Set(repos.map((r) => r.name));
        for (const name of Object.keys(body.bases ?? {})) {
          if (!names.has(name)) return reply.code(400).send({ error: `unknown repo ${name}` });
        }
        projectRepoList = [];
        for (const r of repos) {
          if (!r.workspace) return reply.code(409).send({ error: `repo ${r.name} has no workspace` });
          const b = body.bases?.[r.name] ?? (await defaultBaseBranch(ctx, r.workspace));
          projectRepoList.push({ name: r.name, workspace: r.workspace, ...(b !== undefined ? { baseBranch: b } : {}) });
        }
      } else if (body.bases !== undefined && !projectReopened) {
        return reply.code(409).send({ error: "the project folder is not a git repo" });
      }
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
        cwd = worktree.path;
      }
    } else {
      cwd = path.resolve(body.cwd ?? root);
      if (cwd !== root && !insideWorkspaces(root, cwd)) return reply.code(400).send({ error: "cwd must be inside the workspaces folder" });
    }
    // GM_PROJECT_ID: which project the terminal is on, for the tools started in it.
    const projectEnv = project ? { GM_PROJECT_ID: project.id } : undefined;
    const adapter = body.agent !== undefined ? getAgent(body.agent) : undefined;
    // A new worktree is cut right before the terminal starts, after any agent preparation committed in the checkout.
    // Answers the WorktreeError of an unknown base branch; true when it replied.
    const warnings: string[] = [];
    const newWorktree = async (): Promise<boolean> => {
      if (project && projectRepoList) {
        const id = newWorktreeId();
        try {
          projectWt = { id, ...(await addProjectWorktrees(cwd, projectRepoList, id)) };
        } catch (err) {
          if (err instanceof WorktreeError) {
            await reply.code(err.status).send({ error: err.message, ...err.extra });
            return true;
          }
          throw err;
        }
        cwd = projectWt.path;
        warnings.push(...projectWt.warnings);
        return false;
      }
      if (!ws || reopened) return false;
      const b = body.base ?? (await defaultBaseBranch(ctx, ws));
      try {
        worktree = await addTerminalWorktree(ws.path, b !== undefined ? { baseBranch: b } : {});
      } catch (err) {
        if (err instanceof WorktreeError) {
          await reply.code(err.status).send({ error: err.message, ...err.extra });
          return true;
        }
        throw err;
      }
      if (worktree) {
        cwd = worktree.path;
        if (worktree.warning) warnings.push(worktree.warning);
      }
      return false;
    };
    const withWarnings = <T extends object>(info: T) => (warnings.length > 0 ? { ...info, warnings } : info);
    const wtOf = () => {
      if (projectWt) {
        const repos = projectWt.repos.map((r) => ({
          name: r.name,
          ...(r.branch ? { branch: r.branch } : {}),
          ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
          isolated: r.isolated,
        }));
        return { id: projectWt.id, path: projectWt.path, branch: projectWt.branch, repos };
      }
      return worktree
        ? { id: worktree.id, path: worktree.path, branch: worktree.branch, ...(worktree.baseBranch ? { baseBranch: worktree.baseBranch } : {}) }
        : undefined;
    };
    const save = async (terminalId: string, title: string) => {
      if (worktree && ws) await saveWorktree(ctx, ws, worktree, terminalId, title);
      if (projectWt && project && projectReopened) {
        const wid = projectWt.id;
        const base = projectWt.base;
        await ctx.store.update((d) => {
          const r = d.projectWorktrees[wid];
          if (r) {
            r.terminalId = terminalId;
            r.base = base;
            delete r.kept;
          }
        });
      } else if (projectWt && project) await saveProjectWorktree(ctx, project.id, projectWt, terminalId, title);
    };
    if (!adapter) {
      if (await newWorktree()) return reply;
      const info = terminals.create({
        cwd,
        workspaceId,
        projectId: project?.id,
        title: body.title?.trim() || project?.name,
        cols: body.cols,
        rows: body.rows,
        env: projectEnv,
        worktree: wtOf(),
      });
      await save(info.id, info.title);
      return reply.code(201).send(withWarnings(info));
    }
    if (!isInstalled(adapter)) return reply.code(400).send({ error: `${adapter.binary} is not installed` });
    let connected: PrepareResult | undefined;
    if (adapter.connect === "project-config") {
      if (!ws && !project) return reply.code(400).send({ error: `${adapter.label} needs a workspace` });
      try {
        // On a project the file goes into the project folder's own repo, never into a workspace. On a workspace it is
        // committed once in the checkout, as before worktrees, so every new worktree has it; a kept worktree reopened
        // without it gets it there, with its base moved past graph-manager's own commit.
        connected = await prepareProjectConfig(adapter, reopened && worktree ? { path: worktree.path } : (ws ?? { path: cwd }));
      } catch (err) {
        if (err instanceof AgentPrepareError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
      if (reopened && worktree && connected.changed) {
        const head = await execa("git", ["rev-parse", "HEAD"], { cwd: worktree.path, reject: false });
        if (head.exitCode === 0) worktree.base = String(head.stdout).trim();
      }
      if (projectReopened && projectWt && connected.changed) {
        const head = await execa("git", ["rev-parse", "HEAD"], { cwd: projectWt.path, reject: false });
        if (head.exitCode === 0) projectWt.base = String(head.stdout).trim();
      }
    }
    if (await newWorktree()) return reply;
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
      worktree: wtOf(),
    });
    await save(info.id, info.title);
    return reply.code(201).send(withWarnings(connected ? { ...info, connected } : info));
  });

  // Closing a terminal (KAN-100): its worktree goes with it when it holds no work; with work, the user chooses.
  app.delete<{ Params: { id: string }; Querystring: { worktree?: string } }>("/api/terminals/:id", async (req, reply) => {
    const id = req.params.id;
    const info = terminals.get(id);
    if (!info) return reply.code(404).send({ error: "terminal not found" });
    const { worktree: choice } = deleteQuery.parse(req.query ?? {});
    const projectEntry = projectWorktreeOfTerminal(ctx, id);
    if (projectEntry) {
      const [wid, rec] = projectEntry;
      const state = await projectWorktreeState(rec);
      if (choice === undefined && projectHasWork(state)) {
        return reply.code(409).send({
          error: "the terminal has work",
          needsChoice: true,
          project: state.project,
          repos: state.repos,
          branch: rec.branch,
          worktreeId: wid,
        });
      }
      terminals.remove(id);
      if (choice === "keep") {
        await ctx.store.update((d) => {
          const r = d.projectWorktrees[wid];
          if (r) {
            delete r.terminalId;
            r.kept = true;
          }
        });
      } else {
        await removeProjectWorktrees(projectDirOf(config.workspacesDir, rec.projectId), rec, (wsId) => resolveWorkspace(root, wsId)?.path);
        await ctx.store.update((d) => {
          delete d.projectWorktrees[wid];
        });
      }
      return reply.code(204).send();
    }
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

/** The stored project worktrees of an open terminal, with their id. */
export function projectWorktreeOfTerminal(ctx: AppContext, terminalId: string): [string, ProjectWorktreeRecord] | undefined {
  return Object.entries(ctx.store.get().projectWorktrees).find(([, r]) => r.terminalId === terminalId && !r.kept);
}

/**
 * The worktree of one repo (by its workspace) in an open project terminal's worktrees: `repos/<name>`'s target. A repo
 * without a commit is not isolated: its checkout, with no branch.
 */
export function repoWorktreeOfTerminal(
  ctx: AppContext,
  terminalId: string,
  workspaceId: string,
): { path: string; branch?: string; isolated: boolean } | undefined {
  const entry = projectWorktreeOfTerminal(ctx, terminalId);
  const repo = entry?.[1].repos.find((r) => r.workspaceId === workspaceId);
  if (!repo) return undefined;
  return repo.isolated ? { path: repo.path, ...(repo.branch ? { branch: repo.branch } : {}), isolated: true } : { path: repo.path, isolated: false };
}

/** The project worktrees of a project that no open terminal uses: kept on close, or left from before a restart. */
export function keptProjectWorktrees(ctx: AppContext, projectId: string): [string, ProjectWorktreeRecord][] {
  return Object.entries(ctx.store.get().projectWorktrees).filter(
    ([, r]) => r.projectId === projectId && (r.kept || r.terminalId === undefined || ctx.terminals.get(r.terminalId) === undefined),
  );
}

async function saveProjectWorktree(ctx: AppContext, projectId: string, wt: ProjectWorktrees & { id: string }, terminalId: string, title: string): Promise<void> {
  await ctx.store.update((d) => {
    const old = d.projectWorktrees[wt.id];
    d.projectWorktrees[wt.id] = {
      projectId,
      path: wt.path,
      branch: wt.branch,
      base: wt.base,
      title: old?.title ?? title,
      createdAt: old?.createdAt ?? new Date().toISOString(),
      terminalId,
      repos: wt.repos,
    };
  });
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
    const projectIds = new Set(Object.values(ctx.store.get().projectWorktrees).map((r) => r.projectId));
    const projectAll = await Promise.all([...projectIds].filter((pid) => ctx.store.project(pid)).map((pid) => keptProjectWorktreeList(pid)));
    return {
      worktrees: all.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      projectWorktrees: projectAll.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  });

  /** The kept project worktrees of a project, with what each holds, oldest first. */
  const keptProjectWorktreeList = async (projectId: string) => {
    const list = await Promise.all(
      keptProjectWorktrees(ctx, projectId)
        .filter(([, r]) => existsSync(r.path))
        .map(async ([id, r]) => {
          const state = await projectWorktreeState(r);
          const repos = state.repos.map((x) => {
            const baseBranch = r.repos.find((y) => y.name === x.name)?.baseBranch;
            return { ...x, ...(baseBranch ? { baseBranch } : {}) };
          });
          return { id, projectId, path: r.path, branch: r.branch, title: r.title, createdAt: r.createdAt, project: state.project, repos };
        }),
    );
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/worktrees", async (req, reply) => {
    const project = ctx.store.project(req.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return { worktrees: await keptProjectWorktreeList(project.id) };
  });

  app.delete<{ Params: { id: string; wid: string } }>("/api/projects/:id/worktrees/:wid", async (req, reply) => {
    const rec = ctx.store.get().projectWorktrees[req.params.wid];
    if (!rec || rec.projectId !== req.params.id) return reply.code(404).send({ error: "worktree not found" });
    if (!keptProjectWorktrees(ctx, rec.projectId).some(([id]) => id === req.params.wid)) {
      return reply.code(409).send({ error: "the worktree is open in a terminal" });
    }
    await removeProjectWorktrees(projectDirOf(ctx.config.workspacesDir, rec.projectId), rec, (wsId) => resolveWorkspace(root, wsId)?.path);
    await ctx.store.update((d) => {
      delete d.projectWorktrees[req.params.wid];
    });
    return reply.code(204).send();
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

  // The branches a new terminal can start from (New Terminal dialog); `?fetch=1` fetches origin first.
  app.get<{ Params: { id: string }; Querystring: { fetch?: string } }>("/api/workspaces/:id/branches", async (req, reply) => {
    const ws = resolveWorkspace(root, req.params.id);
    if (!ws) return reply.code(404).send({ error: "workspace not found" });
    const fetch = req.query?.fetch === "1" || req.query?.fetch === "true";
    return branchInfo(ctx, ws, { fetch });
  });

  // Create PR from a terminal worktree (open or kept): commit, push gm-term/<id>, open the PR, then remove the worktree.
  const prBody = z.object({ title: z.string().optional(), body: z.string().optional(), base: z.string().trim().optional(), retry: z.boolean().optional() });
  const worktreeFor = (wsId: string, wid: string) => {
    const ws = resolveWorkspace(root, wsId);
    const rec = ctx.store.get().terminalWorktrees[wid];
    return ws && rec && rec.workspaceId === ws.id && existsSync(rec.path) ? { ws, rec } : undefined;
  };
  const startPrOn = async (reply: FastifyReply, wsId: string, wid: string, raw: unknown) => {
    const found = worktreeFor(wsId, wid);
    if (!found) return reply.code(404).send({ error: "worktree not found" });
    try {
      const job = await startWorktreePr(ctx, found.ws, wid, found.rec, prBody.parse(raw ?? {}));
      return reply.code(202).send({ job });
    } catch (err) {
      if (err instanceof PrError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };
  const jobOn = (reply: FastifyReply, wsId: string, wid: string) => {
    const ws = resolveWorkspace(root, wsId);
    if (!ws) return reply.code(404).send({ error: "workspace not found" });
    const job = currentWorktreeJob(ctx, ws, wid);
    const pr = ctx.store.get().prs[worktreePrKey(ws, wid)];
    return { ...(job ? { job } : {}), ...(pr ? { pr: { url: pr.url, number: pr.number, branch: pr.branch, ...(pr.base ? { base: pr.base } : {}) } } : {}) };
  };
  app.post<{ Params: { id: string; wid: string } }>("/api/workspaces/:id/worktrees/:wid/pr", (req, reply) => startPrOn(reply, req.params.id, req.params.wid, req.body));
  app.get<{ Params: { id: string; wid: string } }>("/api/workspaces/:id/worktrees/:wid/pr", async (req, reply) => jobOn(reply, req.params.id, req.params.wid));
  // Create PR for a project terminal (open or kept): one linked PR per repo with work.
  const projectPrBody = z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    bases: z.record(z.string(), z.string().trim().min(1)).optional(),
    retry: z.boolean().optional(),
  });
  const startProjectPrOn = async (reply: FastifyReply, projectId: string, wid: string, raw: unknown) => {
    const rec = ctx.store.get().projectWorktrees[wid];
    if (!rec || rec.projectId !== projectId || !existsSync(rec.path)) return reply.code(404).send({ error: "worktree not found" });
    const parsed = projectPrBody.safeParse(raw ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    try {
      const job = await startProjectWorktreePr(ctx, projectId, wid, rec, parsed.data);
      return reply.code(202).send({ job });
    } catch (err) {
      if (err instanceof PrError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };
  app.post<{ Params: { id: string; wid: string } }>("/api/projects/:id/worktrees/:wid/pr", (req, reply) =>
    startProjectPrOn(reply, req.params.id, req.params.wid, req.body),
  );
  app.get<{ Params: { id: string; wid: string } }>("/api/projects/:id/worktrees/:wid/pr", async (req) => {
    const { id, wid } = req.params;
    const job = currentProjectWorktreeJob(ctx, id, wid);
    const all = ctx.store.get().prs;
    const prefix = projectWorktreePrKey(id, wid, "");
    const prs: Record<string, { url: string; number: number; branch: string; base?: string }> = {};
    for (const [key, pr] of Object.entries(all)) {
      if (key.startsWith(prefix)) prs[key.slice(prefix.length)] = { url: pr.url, number: pr.number, branch: pr.branch, ...(pr.base ? { base: pr.base } : {}) };
    }
    return { ...(job ? { job } : {}), ...(Object.keys(prs).length > 0 ? { prs } : {}) };
  });

  app.post<{ Params: { id: string } }>("/api/terminals/:id/pr", async (req, reply) => {
    const projectEntry = projectWorktreeOfTerminal(ctx, req.params.id);
    if (projectEntry) return startProjectPrOn(reply, projectEntry[1].projectId, projectEntry[0], req.body);
    const entry = worktreeOfTerminal(ctx, req.params.id);
    if (!entry) return reply.code(404).send({ error: "the terminal has no worktree" });
    return startPrOn(reply, entry[1].workspaceId, entry[0], req.body);
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
