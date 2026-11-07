import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { TerminalRunningError } from "../terminals.js";
import { insideWorkspaces, resolveWorkspace } from "../workspaces.js";

const createBody = z
  .object({
    workspaceId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    cols: z.number().int().min(2).max(1000).optional(),
    rows: z.number().int().min(2).max(1000).optional(),
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

  app.post("/api/terminals", async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    let cwd: string;
    let workspaceId: string | undefined;
    if (body.workspaceId !== undefined) {
      const ws = resolveWorkspace(root, body.workspaceId);
      if (!ws) return reply.code(404).send({ error: "workspace not found" });
      cwd = ws.path;
      workspaceId = ws.id;
    } else {
      cwd = path.resolve(body.cwd ?? root);
      if (cwd !== root && !insideWorkspaces(root, cwd)) return reply.code(400).send({ error: "cwd must be inside the workspaces folder" });
    }
    const info = terminals.create({ cwd, workspaceId, title: body.title, cols: body.cols, rows: body.rows });
    return reply.code(201).send(info);
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
