import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { defaultRecipe, IMAGE_PATTERN, normalizeRecipe, recipeSchema, type SandboxRecipe, sandboxDockerfile, validateRecipe } from "../sandbox-image.js";
import { resolveWorkspace } from "../workspaces.js";

export { IMAGE_PATTERN };

const limitsBody = z
  .object({
    cpus: z.number().min(0.1).max(256),
    memoryMb: z.number().int().min(256).max(1048576),
    pids: z.number().int().min(64).max(1000000),
  })
  .strict();

/** The settings body: `{ limits?, recipe? }` (`recipe: null` = back to the default). The flat limits body is still accepted. */
const settingsBody = z.object({ limits: limitsBody.optional(), recipe: recipeSchema.nullable().optional() }).strict();

const BUILDING_SAVE = "the sandbox image is building; try again when it is ready";

const wsSettingsBody = z.object({ image: z.string().trim().max(255).nullable() }).strict();

export async function sandboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/sandbox/status", async () => (ctx.sandboxes ? await ctx.sandboxes.status() : { available: false, reason: "sandboxes are not set up" }));

  const settingsView = () => {
    const d = ctx.store.get();
    const recipe: SandboxRecipe = d.sandboxRecipe ?? defaultRecipe(ctx.config);
    return { limits: d.sandboxLimits, recipe, defaultRecipe: defaultRecipe(ctx.config), dockerfile: sandboxDockerfile(recipe) };
  };

  app.get("/api/settings/sandbox", async () => settingsView());

  app.put("/api/settings/sandbox", async (req, reply) => {
    const raw = req.body ?? {};
    const isFlat = typeof raw === "object" && raw !== null && !Array.isArray(raw) && !("limits" in raw) && !("recipe" in raw) && Object.keys(raw).length > 0;
    const body = isFlat ? { limits: limitsBody.parse(raw) } : settingsBody.parse(raw);
    let recipe: SandboxRecipe | null | undefined;
    if (body.recipe) {
      const error = validateRecipe(body.recipe);
      if (error) return reply.code(400).send({ error });
      recipe = normalizeRecipe(body.recipe);
    } else if (body.recipe === null) {
      recipe = null;
    }
    let changed = false;
    if (recipe !== undefined) {
      const before = settingsView().dockerfile;
      const after = sandboxDockerfile(recipe ?? defaultRecipe(ctx.config));
      changed = after !== before;
      if (changed && ctx.sandboxes?.buildState().state === "building") return reply.code(409).send({ error: BUILDING_SAVE });
    }
    await ctx.store.update((d) => {
      if (body.limits) d.sandboxLimits = body.limits;
      if (recipe === null) delete d.sandboxRecipe;
      else if (recipe) d.sandboxRecipe = recipe;
    });
    if (changed && ctx.sandboxes?.canBuild()) void ctx.sandboxes.ensureImages();
    return settingsView();
  });

  app.post("/api/sandbox/rebuild", async (_req, reply) => {
    const sb = ctx.sandboxes;
    if (!sb) return reply.code(400).send({ error: "sandboxes are not set up" });
    const res = await sb.rebuild();
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return reply.code(202).send({ build: sb.buildState() });
  });

  app.get("/api/sandbox/build", async () => (ctx.sandboxes ? ctx.sandboxes.buildState() : { state: "idle", log: [] }));

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
