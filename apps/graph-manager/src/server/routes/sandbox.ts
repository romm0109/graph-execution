import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { resolveWorkspace } from "../workspaces.js";

const limitsBody = z
  .object({
    cpus: z.number().min(0.1).max(256),
    memoryMb: z.number().int().min(256).max(1048576),
    pids: z.number().int().min(64).max(1000000),
  })
  .strict();

/** A Docker image reference: `name[:tag][@digest]`, optionally with a registry and path. */
export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;

const wsSettingsBody = z.object({ image: z.string().trim().max(255).nullable() }).strict();

export async function sandboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/sandbox/status", async () => (ctx.sandboxes ? await ctx.sandboxes.status() : { available: false, reason: "sandboxes are not set up" }));

  app.get("/api/settings/sandbox", async () => ({ limits: ctx.store.get().sandboxLimits }));

  app.put("/api/settings/sandbox", async (req) => {
    const limits = limitsBody.parse(req.body ?? {});
    await ctx.store.update((d) => {
      d.sandboxLimits = limits;
    });
    return { limits: ctx.store.get().sandboxLimits };
  });

  const view = (id: string): { image: string | null; sandbox: boolean } => {
    const s = ctx.store.get().workspaceSettings[id];
    return { image: s?.image ?? null, sandbox: s?.sandbox === true };
  };

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return view(ws.id);
  });

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const { image } = wsSettingsBody.parse(req.body ?? {});
    if (image && !IMAGE_PATTERN.test(image)) return reply.code(400).send({ error: "image: not a valid image reference" });
    await ctx.store.update((d) => {
      const next = { ...d.workspaceSettings[ws.id] };
      delete next.image;
      if (image) next.image = image;
      if (Object.keys(next).length === 0) delete d.workspaceSettings[ws.id];
      else d.workspaceSettings[ws.id] = next;
    });
    return view(ws.id);
  });
}
