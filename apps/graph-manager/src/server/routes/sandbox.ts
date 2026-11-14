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
import { PROJECT_PREFIX, resolveRunHome } from "../runhome.js";
import type { UserStore } from "../store.js";
import { WS_BUILDING_START } from "../sandbox.js";
import { isRepoId } from "../workspaces.js";

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

  const settingsView = (us: UserStore) => {
    const d = us.get();
    const recipe: SandboxRecipe = d.sandboxRecipe ?? defaultRecipe(ctx.config);
    const dockerfile = sandboxDockerfile(recipe);
    return { limits: d.sandboxLimits, recipe, defaultRecipe: defaultRecipe(ctx.config), toolchains: TOOLCHAINS, dockerfile, image: sandboxImageTag(dockerfile) };
  };

  app.get("/api/settings/sandbox", async (req) => settingsView(await ctx.store.forUser(req.user)));

  app.put("/api/settings/sandbox", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
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
      const before = settingsView(us).dockerfile;
      const after = sandboxDockerfile(recipe ?? defaultRecipe(ctx.config));
      changed = after !== before;
      const globalState = ctx.sandboxes?.buildState().state;
      if (changed && (globalState === "building" || globalState === "queued")) return reply.code(409).send({ error: BUILDING_SAVE });
    }
    await us.update((d) => {
      if (body.limits) d.sandboxLimits = body.limits;
      if (recipe === null) delete d.sandboxRecipe;
      else if (recipe) d.sandboxRecipe = recipe;
    });
    if (changed && ctx.sandboxes?.canBuild()) void ctx.sandboxes.ensureImages();
    return settingsView(us);
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

  const view = (us: UserStore, id: string) => {
    const s = us.get().workspaceSettings[id];
    const source = s?.image ? "image" : s?.recipe ? "recipe" : "global";
    return {
      sandbox: s?.sandbox === true,
      source,
      image: s?.image ?? null,
      recipe: s?.recipe ?? null,
      dockerfile: s?.recipe ? sandboxDockerfile(s.recipe) : null,
      effectiveImage: ctx.sandboxes?.imageFor(id).image ?? sandboxImageTag(sandboxDockerfile(us.get().sandboxRecipe ?? defaultRecipe(ctx.config))),
    };
  };
  const idleBuild = { state: "idle" as const, log: [] as string[] };
  /** A repository id (checked by its syntax only: a hosted session's clone is not on this machine), or undefined. */
  const repoId = (id: string): { id: string } | undefined => (isRepoId(id) ? { id } : undefined);

  // Settings → Repositories: every repository of the user with settings, saved run defaults or a live session.
  app.get("/api/repositories", async (req) => {
    const us = await ctx.store.forUser(req.user);
    const d = us.get();
    const ids = new Set<string>([
      ...Object.keys(d.workspaceSettings),
      ...Object.keys(d.runDefaults),
      ...Object.values(d.sessions)
        .map((s) => s.workspaceId)
        .filter((id) => id !== ""),
    ]);
    const repositories = [...ids]
      .filter((id) => !id.startsWith(PROJECT_PREFIX) && isRepoId(id))
      .map((id) => {
        const parts = id.split("~");
        const defaults = d.runDefaults[id];
        return {
          id,
          forge: parts[0]!,
          fullPath: parts.slice(1).join("/"),
          settings: view(us, id),
          ...(defaults ? { runDefaults: defaults } : {}),
        };
      })
      .sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.forge.localeCompare(b.forge));
    return { repositories };
  });

  // Read-only for a project (`project~<id>`): the Start run drawer reads the saved switch; PUT stays repository-only.
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    if (req.params.id.startsWith(PROJECT_PREFIX)) {
      const home = resolveRunHome(ctx.config.workspacesDir, us, req.params.id);
      if (!home) return reply.code(404).send({ error: "unknown workspace" });
      return view(us, home.id);
    }
    if (!repoId(req.params.id)) return reply.code(404).send({ error: "unknown workspace" });
    return view(us, req.params.id);
  });

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    const ws = repoId(req.params.id);
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
      const before = us.get().workspaceSettings[ws.id]?.recipe;
      const changed = !before || sandboxDockerfile(before) !== sandboxDockerfile(recipe);
      if (changed && sb?.isWsBuilding(ws.id)) return reply.code(409).send({ error: WS_BUILDING_START });
    }
    await us.update((d) => {
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
      // The instance's own store builds through the workspace build; another user's recipe through the shared queue.
      if (missing && sb.imageFor(ws.id).image === tag) sb.queueWorkspaceBuild(ws.id);
      else if (missing) sb.queueRecipeBuild(recipe);
      else sb.clearWsFailure(ws.id);
    }
    return { ...view(us, ws.id), build: sb ? sb.wsBuildState(ws.id) : idleBuild };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/sandbox/build", async (req, reply) => {
    const ws = repoId(req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return ctx.sandboxes ? ctx.sandboxes.wsBuildState(ws.id) : idleBuild;
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/sandbox/rebuild", async (req, reply) => {
    const ws = repoId(req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const sb = ctx.sandboxes;
    if (!sb) return reply.code(400).send({ error: "sandboxes are not set up" });
    if (sb.imageFor(ws.id).source !== "recipe") return reply.code(400).send({ error: "the workspace has no own recipe" });
    if (sb.isWsBuilding(ws.id)) return reply.code(409).send({ error: WS_BUILDING_START });
    sb.queueWorkspaceBuild(ws.id, { force: true });
    return reply.code(202).send({ build: sb.wsBuildState(ws.id) });
  });
}
