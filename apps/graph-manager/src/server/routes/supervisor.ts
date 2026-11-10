import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { supervisorModeOf } from "../store.js";
import { resolveWorkspace } from "../workspaces.js";

const body = z.object({ mode: z.enum(["report", "act"]) }).strict();

/**
 * The workspace's Supervisor setting (KAN-92, docs/prd/agent-supervisor.md): what the agent that started a run does
 * when the run fails, `report` (default) or `act`.
 */
export async function supervisorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/supervisor", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return { mode: supervisorModeOf(ctx.store.get(), ws.id) };
  });

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/supervisor", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    // A ZodError answers 400 via the app's error handler.
    const { mode } = body.parse(req.body ?? {});
    await ctx.store.update((d) => {
      d.workspaceSettings[ws.id] = { ...d.workspaceSettings[ws.id], supervisor: mode };
    });
    return reply.code(204).send();
  });
}
