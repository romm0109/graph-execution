import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  void ctx;
  app.get("/api/health", async () => ({ ok: true }));
  // Unauthenticated (outside /api) for Docker HEALTHCHECK and OpenShift probes. It reveals nothing.
  app.get("/healthz", async () => ({ ok: true }));
}
