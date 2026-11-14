// The agents' UI requests (src/server/agent-requests.ts) for the browser; behind the session cookie like all of /api/.
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

export async function agentRequestRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/agent-requests", async () => ({ requests: ctx.agentRequests.list() }));

  app.post<{ Params: { id: string } }>("/api/agent-requests/:id/ack", async (req, reply) =>
    ctx.agentRequests.ack(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "request not found" }),
  );
}
