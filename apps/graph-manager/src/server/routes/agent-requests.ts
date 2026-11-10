// The agents' UI requests (src/server/agent-requests.ts) for the browser; behind the session cookie like all of /api/.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";

const ackBody = z.object({ result: z.enum(["approved", "rejected"]).optional() });

export async function agentRequestRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/agent-requests", async () => ({ requests: ctx.agentRequests.list() }));

  // An optional `result` answers a propose-graph request: "rejected" types a line into the calling terminal.
  app.post<{ Params: { id: string } }>("/api/agent-requests/:id/ack", async (req, reply) => {
    const parsed = ackBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "result must be approved or rejected" });
    const r = ctx.agentRequests.get(req.params.id);
    if (!r || !ctx.agentRequests.ack(r.id)) return reply.code(404).send({ error: "request not found" });
    if (r.kind === "propose-graph" && parsed.data.result === "rejected")
      ctx.terminals.typeWhenIdle(r.terminalId, `[graph-manager] The user rejected the graph ${r.prefill.tasksDir}.`);
    return reply.code(204).send();
  });
}
