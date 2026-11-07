import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { PrError, currentJob, prStatus, startPr, type PrStatusWithJob } from "../pr.js";
import { isRunId } from "../runs.js";
import { resolveWorkspace } from "../workspaces.js";

const createBody = z.object({
  branch: z.string().trim().min(1, "branch is required"),
  title: z.string().trim().min(1, "title is required"),
  body: z.string().default(""),
  base: z.string().trim().optional(),
});

type Params = { Params: { ws: string; runId: string } };

export async function prRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<Params>("/api/runs/:ws/:runId/pr", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const status = await prStatus(ctx, ws, req.params.runId);
    if (!status) return reply.code(404).send({ error: "unknown run" });
    const job = currentJob(ctx, ws, req.params.runId);
    const res: PrStatusWithJob = job ? { ...status, job } : status;
    return res;
  });

  app.post<Params>("/api/runs/:ws/:runId/pr", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const body = createBody.parse(req.body ?? {});
    try {
      const job = await startPr(ctx, ws, req.params.runId, body);
      return reply.code(202).send({ job });
    } catch (err) {
      if (err instanceof PrError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
