import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { AGENT_IDS, AGENTS, AgentPrepareError, commandLine, getAgent, isInstalled, prepareProjectConfig, type PrepareResult } from "../agents.js";
import { PROJECT_FILE, projectDirOf, type Project } from "../projects.js";
import { batchOutput } from "../output-batch.js";
import { TerminalRunningError } from "../terminals.js";
import { insideWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";

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
    } else {
      cwd = path.resolve(body.cwd ?? root);
      if (cwd !== root && !insideWorkspaces(root, cwd)) return reply.code(400).send({ error: "cwd must be inside the workspaces folder" });
    }
    // GM_PROJECT_ID: which project the terminal is on, for the tools started in it.
    const projectEnv = project ? { GM_PROJECT_ID: project.id } : undefined;
    const adapter = body.agent !== undefined ? getAgent(body.agent) : undefined;
    if (!adapter) {
      const info = terminals.create({
        cwd,
        workspaceId,
        projectId: project?.id,
        title: body.title?.trim() || project?.name,
        cols: body.cols,
        rows: body.rows,
        env: projectEnv,
      });
      return reply.code(201).send(info);
    }
    if (!isInstalled(adapter)) return reply.code(400).send({ error: `${adapter.binary} is not installed` });
    let connected: PrepareResult | undefined;
    if (adapter.connect === "project-config") {
      if (!ws && !project) return reply.code(400).send({ error: `${adapter.label} needs a workspace` });
      try {
        // On a project the file goes into the project folder's own repo, never into a workspace.
        connected = await prepareProjectConfig(adapter, ws ?? { path: cwd });
      } catch (err) {
        if (err instanceof AgentPrepareError) return reply.code(err.status).send({ error: err.message });
        throw err;
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
    });
    return reply.code(201).send(connected ? { ...info, connected } : info);
  });

  app.delete<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    if (!terminals.remove(req.params.id)) return reply.code(404).send({ error: "terminal not found" });
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
      else att.resize(msg.data.cols, msg.data.rows);
    });
    socket.on("close", () => {
      output.dispose();
      att.detach();
    });
  });
}
