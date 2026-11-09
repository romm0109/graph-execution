import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  defaultRecipe,
  IMAGE_PATTERN,
  normalizeRecipe,
  recipeSchema,
  type SandboxRecipe,
  sandboxDockerfile,
  sandboxImageTag,
  TOOLCHAINS,
  validateRecipe,
} from "../sandbox-image.js";
import { WS_BUILDING_START } from "../sandbox.js";
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

/** The body of the Dockerfile preview: a recipe that isn't saved. */
const previewBody = z.object({ recipe: recipeSchema }).strict();

const BUILDING_SAVE = "the sandbox image is building; try again when it is ready";

/** The workspace settings body: the image source, or the old `{ image }` (a non-empty image = `image`, else `global`). */
const wsSettingsBody = z.union([
  z.object({ source: z.literal("global") }).strict(),
  z.object({ source: z.literal("image"), image: z.string().trim().max(255) }).strict(),
  z.object({ source: z.literal("recipe"), recipe: recipeSchema }).strict(),
  z.object({ image: z.string().trim().max(255).nullable() }).strict(),
]);

export async function sandboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/sandbox/status", async () => (ctx.sandboxes ? await ctx.sandboxes.status() : { available: false, reason: "sandboxes are not set up" }));

  const settingsView = () => {
    const d = ctx.store.get();
    const recipe: SandboxRecipe = d.sandboxRecipe ?? defaultRecipe(ctx.config);
    const dockerfile = sandboxDockerfile(recipe);
    return { limits: d.sandboxLimits, recipe, defaultRecipe: defaultRecipe(ctx.config), toolchains: TOOLCHAINS, dockerfile, image: sandboxImageTag(dockerfile) };
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
      const globalState = ctx.sandboxes?.buildState().state;
      if (changed && (globalState === "building" || globalState === "queued")) return reply.code(409).send({ error: BUILDING_SAVE });
    }
    await ctx.store.update((d) => {
      if (body.limits) d.sandboxLimits = body.limits;
      if (recipe === null) delete d.sandboxRecipe;
      else if (recipe) d.sandboxRecipe = recipe;
    });
    if (changed && ctx.sandboxes?.canBuild()) void ctx.sandboxes.ensureImages();
    return settingsView();
  });

  // The Dockerfile and image tag of a recipe that isn't saved; a recipe validateRecipe rejects still answers 200, with `error`.
  app.post("/api/sandbox/dockerfile", async (req) => {
    const { recipe } = previewBody.parse(req.body ?? {});
    const dockerfile = sandboxDockerfile(normalizeRecipe(recipe));
    const error = validateRecipe(recipe);
    return { dockerfile, image: sandboxImageTag(dockerfile), ...(error ? { error } : {}) };
  });

  app.post("/api/sandbox/rebuild", async (_req, reply) => {
    const sb = ctx.sandboxes;
    if (!sb) return reply.code(400).send({ error: "sandboxes are not set up" });
    const res = await sb.rebuild();
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return reply.code(202).send({ build: sb.buildState() });
  });

  app.get("/api/sandbox/build", async () => (ctx.sandboxes ? ctx.sandboxes.buildState() : { state: "idle", log: [] }));

  const view = (id: string) => {
    const s = ctx.store.get().workspaceSettings[id];
    const source = s?.image ? "image" : s?.recipe ? "recipe" : "global";
    return {
      sandbox: s?.sandbox === true,
      source,
      image: s?.image ?? null,
      recipe: s?.recipe ?? null,
      dockerfile: s?.recipe ? sandboxDockerfile(s.recipe) : null,
      effectiveImage: ctx.sandboxes?.imageFor(id).image ?? sandboxImageTag(sandboxDockerfile(ctx.store.get().sandboxRecipe ?? defaultRecipe(ctx.config))),
    };
  };
  const idleBuild = { state: "idle" as const, log: [] as string[] };

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return view(ws.id);
  });

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const body = wsSettingsBody.parse(req.body ?? {});
    let image: string | undefined;
    let recipe: SandboxRecipe | undefined;
    if ("source" in body) {
      if (body.source === "image") image = body.image;
      else if (body.source === "recipe") recipe = body.recipe;
    } else if (body.image) {
      image = body.image;
    }
    if ("source" in body && body.source === "image" && !image) return reply.code(400).send({ error: "image: not a valid image reference" });
    if (image && !IMAGE_PATTERN.test(image)) return reply.code(400).send({ error: "image: not a valid image reference" });
    const sb = ctx.sandboxes;
    if (recipe) {
      const error = validateRecipe(recipe);
      if (error) return reply.code(400).send({ error });
      recipe = normalizeRecipe(recipe);
      const before = ctx.store.get().workspaceSettings[ws.id]?.recipe;
      const changed = !before || sandboxDockerfile(before) !== sandboxDockerfile(recipe);
      if (changed && sb?.isWsBuilding(ws.id)) return reply.code(409).send({ error: WS_BUILDING_START });
    }
    await ctx.store.update((d) => {
      const next = { ...d.workspaceSettings[ws.id] };
      delete next.image;
      delete next.recipe;
      if (image) next.image = image;
      else if (recipe) next.recipe = recipe;
      if (Object.keys(next).length === 0) delete d.workspaceSettings[ws.id];
      else d.workspaceSettings[ws.id] = next;
    });
    if (recipe && sb) {
      const tag = sandboxImageTag(sandboxDockerfile(recipe));
      // Only a missing image is built; saving a recipe whose image exists clears an earlier failure.
      const missing = !(await sb.docker.inspectImage(tag).catch(() => undefined));
      if (missing) sb.queueWorkspaceBuild(ws.id);
      else sb.clearWsFailure(ws.id);
    }
    return { ...view(ws.id), build: sb ? sb.wsBuildState(ws.id) : idleBuild };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/sandbox/build", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return ctx.sandboxes ? ctx.sandboxes.wsBuildState(ws.id) : idleBuild;
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/sandbox/rebuild", async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const sb = ctx.sandboxes;
    if (!sb) return reply.code(400).send({ error: "sandboxes are not set up" });
    if (sb.imageFor(ws.id).source !== "recipe") return reply.code(400).send({ error: "the workspace has no own recipe" });
    if (sb.isWsBuilding(ws.id)) return reply.code(409).send({ error: WS_BUILDING_START });
    sb.queueWorkspaceBuild(ws.id, { force: true });
    return reply.code(202).send({ build: sb.wsBuildState(ws.id) });
  });
}
