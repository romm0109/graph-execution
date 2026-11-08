import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { Sandboxes, type ToolsMount } from "../sandbox.js";
import { DEFAULT_RECIPE, defaultRecipe, type SandboxRecipe, sandboxDockerfile, sandboxImageTag, TOOLCHAINS, type ToolchainId } from "../sandbox-image.js";
import { DATA_FILE } from "../store.js";
import { appWithLogin } from "../test-helpers.js";

let fake: FakeDocker;
let ctx: Awaited<ReturnType<typeof appWithLogin>> | undefined;

beforeEach(async () => {
  fake = await startFakeDocker();
  // The tools step is covered by sandbox-tools.test.ts.
  vi.spyOn(Sandboxes.prototype as unknown as { prepareTools: () => Promise<string | undefined> }, "prepareTools").mockImplementation(async function (
    this: { mount?: ToolsMount },
  ) {
    this.mount = { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
    return undefined;
  });
  vi.spyOn(Sandboxes.prototype as unknown as { buildImages: () => Promise<{ image: string; clisVolume: string }> }, "buildImages").mockImplementation(async function (
    this: { opts: { config: { sandboxImage?: string } } },
  ) {
    // The built image is the recipe's base here: these tests start containers of a known image.
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
  await fake.close();
});

describe("GET /api/sandbox/status", () => {
  it("answers available with a reachable Docker", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    expect(fake.requests).toEqual([]);
    const res = await ctx.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: ctx.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true });
  });

  it("requires login", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    const res = await ctx.app.inject({ method: "GET", url: "/api/sandbox/status" });
    expect(res.statusCode).toBe(401);
  });

  it("answers unavailable with a reason when Docker is not reachable", async () => {
    ctx = await appWithLogin({ dockerSocket: "/nonexistent.sock" });
    const res = await ctx.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: ctx.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ available: boolean; reason?: string }>();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/^Docker is not reachable at \/nonexistent\.sock/);
  });
});

const APT_PYTHON = "RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv pipx && rm -rf /var/lib/apt/lists/*";

/** The default recipe with python enabled. */
function withPython(): SandboxRecipe {
  const r = defaultRecipe({});
  for (const t of r.toolchains) if (t.id === "python") t.enabled = true;
  return r;
}

/** The default recipe with python enabled and the snippet of `id` replaced. */
function withSnippet(id: ToolchainId, snippet: string): SandboxRecipe {
  const r = withPython();
  for (const t of r.toolchains) if (t.id === id) t.snippet = snippet;
  return r;
}

describe("GET/PUT /api/settings/sandbox", () => {
  it("answers the defaults, then stores valid limits", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    const get = await ctx.app.inject({ method: "GET", url: "/api/settings/sandbox", headers: { cookie: ctx.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({
      limits: { cpus: 2, memoryMb: 4096, pids: 2048 },
      recipe: DEFAULT_RECIPE,
      defaultRecipe: DEFAULT_RECIPE,
      toolchains: TOOLCHAINS,
      dockerfile: "FROM node:24.22.1-bookworm\n",
      image: sandboxImageTag("FROM node:24.22.1-bookworm\n"),
    });
    expect(get.json().image).toMatch(/^gm-sandbox:[0-9a-f]{12}$/);

    const limits = { cpus: 4, memoryMb: 8192, pids: 4096 };
    const put = await ctx.app.inject({ method: "PUT", url: "/api/settings/sandbox", headers: { cookie: ctx.cookie }, payload: limits });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ limits, recipe: DEFAULT_RECIPE });
    expect(ctx.store.get().sandboxLimits).toEqual(limits);
    const file = JSON.parse(await readFile(path.join(ctx.config.dataDir, DATA_FILE), "utf8"));
    expect(file.sandboxLimits).toEqual(limits);
  });

  it("rejects out-of-range values and unknown keys", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    const low = await ctx.app.inject({ method: "PUT", url: "/api/settings/sandbox", headers: { cookie: ctx.cookie }, payload: { cpus: 2, memoryMb: 100, pids: 2048 } });
    expect(low.statusCode).toBe(400);
    expect(low.json().error).toContain("memoryMb:");
    const extra = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/sandbox",
      headers: { cookie: ctx.cookie },
      payload: { cpus: 2, memoryMb: 4096, pids: 2048, swap: 1 },
    });
    expect(extra.statusCode).toBe(400);
    expect(ctx.store.get().sandboxLimits).toEqual({ cpus: 2, memoryMb: 4096, pids: 2048 });
  });

  const put = (c: NonNullable<typeof ctx>, payload: unknown) =>
    c.app.inject({ method: "PUT", url: "/api/settings/sandbox", headers: { cookie: c.cookie }, payload: payload as object });

  it("stores a recipe and builds its image, and null restores the default", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const ensure = vi.spyOn(Sandboxes.prototype, "ensureImages");
    expect((await c.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: c.cookie } })).json()).toMatchObject({ available: true });
    ensure.mockClear();
    const recipe = { ...withPython(), base: " node:22 ", extraLines: "RUN true\r\n" };
    const res = await put(c, { recipe });
    expect(res.statusCode).toBe(200);
    const stored = { ...withPython(), base: "node:22", extraLines: "RUN true\n" };
    expect(sandboxDockerfile(stored)).toBe(`FROM node:22\n# Python\n${APT_PYTHON}\nRUN true\n`);
    expect(res.json()).toMatchObject({ recipe: stored, defaultRecipe: DEFAULT_RECIPE, dockerfile: sandboxDockerfile(stored) });
    expect(c.store.get().sandboxRecipe).toEqual(stored);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith();

    // The same recipe again: no build.
    expect((await put(c, { recipe: stored })).statusCode).toBe(200);
    expect(ensure).toHaveBeenCalledTimes(1);

    const reset = await put(c, { recipe: null });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ recipe: DEFAULT_RECIPE, dockerfile: sandboxDockerfile(DEFAULT_RECIPE) });
    expect(c.store.get().sandboxRecipe).toBeUndefined();
    expect(ensure).toHaveBeenCalledTimes(2);

    const both = await put(c, { limits: { cpus: 3, memoryMb: 2048, pids: 512 } });
    expect(both.statusCode).toBe(200);
    expect(c.store.get().sandboxLimits).toEqual({ cpus: 3, memoryMb: 2048, pids: 512 });
  });

  it("rejects an invalid recipe with its message", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const from = await put(c, { recipe: { ...DEFAULT_RECIPE, extraLines: "FROM ubuntu" } });
    expect(from.statusCode).toBe(400);
    expect(from.json()).toEqual({ error: "extraLines: FROM is not allowed; use COPY --from=<image>" });
    const snip = await put(c, { recipe: withSnippet("python", "RUN true\nFROM ubuntu") });
    expect(snip.statusCode).toBe(400);
    expect(snip.json()).toEqual({ error: "toolchains.python: FROM is not allowed; use COPY --from=<image>" });
    expect((await put(c, { recipe: { ...DEFAULT_RECIPE, packages: ["jq"] } })).statusCode).toBe(400);
    expect((await put(c, { recipe: { ...DEFAULT_RECIPE, extra: 1 } })).statusCode).toBe(400);
    expect((await put(c, { recipe: DEFAULT_RECIPE, cpus: 2 })).statusCode).toBe(400);
    expect(c.store.get().sandboxRecipe).toBeUndefined();
  });

  it("answers 409 for a changed recipe while the image builds", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    vi.spyOn(Sandboxes.prototype, "buildState").mockReturnValue({ state: "building", step: "image", log: [] });
    const res = await put(c, { recipe: withPython() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "the sandbox image is building; try again when it is ready" });
    expect(c.store.get().sandboxRecipe).toBeUndefined();
    // An unchanged recipe is fine.
    expect((await put(c, { recipe: DEFAULT_RECIPE })).statusCode).toBe(200);
  });

  it("requires login", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    expect((await ctx.app.inject({ method: "GET", url: "/api/settings/sandbox" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "PUT", url: "/api/settings/sandbox", payload: { cpus: 1, memoryMb: 512, pids: 64 } })).statusCode).toBe(401);
  });
});

describe("POST /api/sandbox/dockerfile", () => {
  const preview = (c: NonNullable<typeof ctx>, payload: unknown, cookie = true) =>
    c.app.inject({ method: "POST", url: "/api/sandbox/dockerfile", headers: cookie ? { cookie: c.cookie } : {}, payload: payload as object });

  it("answers the Dockerfile and image of an unsaved recipe", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const res = await preview(c, { recipe: { ...withPython(), base: " node:22 " } });
    expect(res.statusCode).toBe(200);
    const dockerfile = `FROM node:22\n# Python\n${APT_PYTHON}\n`;
    expect(res.json()).toEqual({ dockerfile, image: sandboxImageTag(dockerfile) });
    expect(c.store.get().sandboxRecipe).toBeUndefined();
  });

  it("answers 200 with the error of an invalid recipe, and saves nothing", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const res = await preview(c, { recipe: withSnippet("python", "FROM ubuntu") });
    expect(res.statusCode).toBe(200);
    const dockerfile = "FROM node:24.22.1-bookworm\n# Python\nFROM ubuntu\n";
    expect(res.json()).toEqual({ dockerfile, image: sandboxImageTag(dockerfile), error: "toolchains.python: FROM is not allowed; use COPY --from=<image>" });
    expect(c.store.get().sandboxRecipe).toBeUndefined();
  });

  it("answers 400 for a body that isn't a recipe, and 401 without login", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    expect((await preview(c, { recipe: { ...DEFAULT_RECIPE, extra: 1 } })).statusCode).toBe(400);
    expect((await preview(c, { recipe: DEFAULT_RECIPE, more: 1 })).statusCode).toBe(400);
    expect((await preview(c, {})).statusCode).toBe(400);
    expect((await preview(c, { recipe: DEFAULT_RECIPE }, false)).statusCode).toBe(401);
  });
});

describe("POST /api/sandbox/rebuild and GET /api/sandbox/build", () => {
  it("rebuilds both images without the cache and answers the build", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const ensure = vi.spyOn(Sandboxes.prototype, "ensureImages");
    const res = await c.app.inject({ method: "POST", url: "/api/sandbox/rebuild", headers: { cookie: c.cookie } });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ build: { state: string } }>().build.state).toMatch(/^(building|ready)$/);
    expect(ensure).toHaveBeenLastCalledWith({ force: true, clis: true });
    await ensure.mock.results.at(-1)?.value;

    const build = await c.app.inject({ method: "GET", url: "/api/sandbox/build", headers: { cookie: c.cookie } });
    expect(build.statusCode).toBe(200);
    expect(build.json()).toMatchObject({ state: "ready", log: [] });
    expect(build.json<{ startedAt?: string; finishedAt?: string }>().finishedAt).toBeDefined();
  });

  it("answers 409 while building", async () => {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    let finish = (): void => undefined;
    const hold = new Promise<void>((r) => {
      finish = r;
    });
    vi.spyOn(Sandboxes.prototype as unknown as { buildImages: (o: { onLine: (l: string) => void; onStep: (s: string) => void }) => Promise<unknown> }, "buildImages").mockImplementation(
      async (o) => {
        o.onStep("clis");
        o.onLine("Step 1");
        await hold;
        return { image: "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
      },
    );
    expect((await c.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: c.cookie } })).json()).toMatchObject({ building: true });
    const res = await c.app.inject({ method: "POST", url: "/api/sandbox/rebuild", headers: { cookie: c.cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "the sandbox image is building" });
    const build = await c.app.inject({ method: "GET", url: "/api/sandbox/build", headers: { cookie: c.cookie } });
    expect(build.json()).toMatchObject({ state: "building", step: "clis", log: ["Step 1"] });
    finish();
  });

  it("makes the startup build the forced one when Rebuild comes while the tools are prepared", async () => {
    let toolsDone = (): void => undefined;
    const tools = new Promise<void>((r) => {
      toolsDone = r;
    });
    vi.spyOn(Sandboxes.prototype as unknown as { prepareTools: () => Promise<string | undefined> }, "prepareTools").mockImplementation(async function (
      this: { mount?: ToolsMount },
    ) {
      await tools;
      this.mount = { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
      return undefined;
    });
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const ensure = vi.spyOn(Sandboxes.prototype, "ensureImages");
    // The first status call answers at once while the tools are copied (no wait for init).
    const first = c.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: c.cookie } });
    const raced = await Promise.race([first.then((r) => r.json()), new Promise((r) => setTimeout(() => r("timeout"), 300))]);
    // init() may not have reached the tools step on the first call (ping first); a second call then does.
    const st =
      raced === "timeout" || !(raced as { building?: boolean }).building
        ? (await c.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: c.cookie } })).json()
        : raced;
    expect(st).toEqual({ available: false, building: true, clisReady: false, reason: "building the sandbox image" });
    const res = await c.app.inject({ method: "POST", url: "/api/sandbox/rebuild", headers: { cookie: c.cookie } });
    expect(res.statusCode).toBe(202);
    expect((await c.app.inject({ method: "POST", url: "/api/sandbox/rebuild", headers: { cookie: c.cookie } })).statusCode).toBe(409);
    toolsDone();
    await first;
    for (let i = 0; i < 50 && ensure.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ensure.mock.calls).toEqual([[{ force: true, clis: true }]]);
  });

  it("answers 400 when Docker is not reachable", async () => {
    const c = await appWithLogin({ dockerSocket: "/nonexistent.sock" });
    ctx = c;
    const res = await c.app.inject({ method: "POST", url: "/api/sandbox/rebuild", headers: { cookie: c.cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/^Docker is not reachable/);
  });

  it("requires login", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    expect((await ctx.app.inject({ method: "POST", url: "/api/sandbox/rebuild" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/sandbox/build" })).statusCode).toBe(401);
  });
});

describe("GET/PUT /api/workspaces/:id/settings", () => {
  const WS = "github~octo~hello";

  async function withWorkspace(): Promise<NonNullable<typeof ctx>> {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const dir = path.join(c.config.workspacesDir, "github", "octo", "hello");
    await mkdir(dir, { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
    return c;
  }

  const settings = (c: NonNullable<typeof ctx>, method: "GET" | "PUT", payload?: unknown, id = WS, cookie = c.cookie) =>
    c.app.inject({ method, url: `/api/workspaces/${id}/settings`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });

  const globalTag = (c: NonNullable<typeof ctx>): string => sandboxImageTag(sandboxDockerfile(defaultRecipe(c.config)));
  const view = (c: NonNullable<typeof ctx>, over: Record<string, unknown> = {}) => ({
    sandbox: false,
    source: "global",
    image: null,
    recipe: null,
    dockerfile: null,
    effectiveImage: globalTag(c),
    ...over,
  });
  const idle = { state: "idle", log: [] };
  const wsRecipe = (): SandboxRecipe => {
    const r = defaultRecipe({});
    for (const t of r.toolchains) if (t.id === "java") t.enabled = true;
    return { ...r, base: "node:22-bookworm" };
  };
  const wsBuild = (c: NonNullable<typeof ctx>, id = WS, cookie = c.cookie) =>
    c.app.inject({ method: "GET", url: `/api/workspaces/${id}/sandbox/build`, headers: cookie ? { cookie } : {} });
  const wsRebuild = (c: NonNullable<typeof ctx>, id = WS, cookie = c.cookie) =>
    c.app.inject({ method: "POST", url: `/api/workspaces/${id}/sandbox/rebuild`, headers: cookie ? { cookie } : {} });
  const until = async (what: string, fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
    const end = Date.now() + timeoutMs;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("answers no image for a new workspace, then stores one", async () => {
    const c = await withWorkspace();
    const get = await settings(c, "GET");
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(view(c));

    const put = await settings(c, "PUT", { image: "python:3.12-bookworm" });
    expect(put.statusCode).toBe(200);
    const img = view(c, { source: "image", image: "python:3.12-bookworm", effectiveImage: "python:3.12-bookworm" });
    expect(put.json()).toEqual({ ...img, build: idle });
    expect((await settings(c, "GET")).json()).toEqual(img);
  });

  it("saves a workspace recipe, builds its image and follows the build", async () => {
    const c = await withWorkspace();
    const recipe = wsRecipe();
    const tag = sandboxImageTag(sandboxDockerfile(recipe));
    const put = await settings(c, "PUT", { source: "recipe", recipe });
    expect(put.statusCode).toBe(200);
    const body = put.json<{ source: string; image: null; recipe: SandboxRecipe; dockerfile: string; effectiveImage: string; build: { state: string } }>();
    expect(body).toMatchObject({ source: "recipe", image: null, recipe, effectiveImage: tag });
    expect(body.dockerfile.startsWith("FROM node:22-bookworm\n")).toBe(true);
    expect(["queued", "building"]).toContain(body.build.state);
    expect(c.store.get().workspaceSettings[WS]).toEqual({ recipe });
    await until("the workspace build", async () => (await wsBuild(c)).json<{ state: string }>().state === "ready");
    expect(fake.builds.map((b) => b.tag)).toContain(tag);
    // The Rebuild of the workspace image forces it.
    const rb = await wsRebuild(c);
    expect(rb.statusCode).toBe(202);
    expect(["queued", "building"]).toContain(rb.json<{ build: { state: string } }>().build.state);
    await until("the forced build", async () => (await wsBuild(c)).json<{ state: string }>().state === "ready");
    expect(fake.builds.filter((b) => b.tag === tag).map((b) => b.nocache)).toEqual([false, true]);
  });

  it("switches between the sources and keeps the sandbox flag", async () => {
    const c = await withWorkspace();
    await settings(c, "PUT", { source: "recipe", recipe: wsRecipe() });
    await c.store.update((d) => {
      d.workspaceSettings[WS] = { ...d.workspaceSettings[WS], sandbox: true };
    });
    const img = await settings(c, "PUT", { source: "image", image: "python:3.12-bookworm" });
    expect(img.json()).toMatchObject({ source: "image", image: "python:3.12-bookworm", recipe: null, dockerfile: null, sandbox: true });
    expect(c.store.get().workspaceSettings[WS]).toEqual({ image: "python:3.12-bookworm", sandbox: true });
    const glob = await settings(c, "PUT", { source: "global" });
    expect(glob.json()).toMatchObject({ source: "global", image: null, recipe: null, sandbox: true });
    expect(c.store.get().workspaceSettings[WS]).toEqual({ sandbox: true });
  });

  it("rejects an invalid recipe, a rebuild without own recipe and an unknown workspace", async () => {
    const c = await withWorkspace();
    const bad = await settings(c, "PUT", { source: "recipe", recipe: { ...wsRecipe(), extraLines: "FROM ubuntu" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "extraLines: FROM is not allowed; use COPY --from=<image>" });
    expect((await settings(c, "PUT", { source: "image", image: "bad image!" })).json()).toEqual({ error: "image: not a valid image reference" });
    expect((await settings(c, "PUT", { source: "global", image: "node:22" })).statusCode).toBe(400);
    const rb = await wsRebuild(c);
    expect(rb.statusCode).toBe(400);
    expect(rb.json()).toEqual({ error: "the workspace has no own recipe" });
    expect((await wsBuild(c, "github~octo~nope")).statusCode).toBe(404);
    expect((await wsRebuild(c, "github~octo~nope")).statusCode).toBe(404);
    expect((await settings(c, "PUT", { source: "global" }, "github~octo~nope")).statusCode).toBe(404);
    expect((await wsBuild(c, WS, "")).statusCode).toBe(401);
    expect((await wsRebuild(c, WS, "")).statusCode).toBe(401);
    expect((await settings(c, "PUT", { source: "global" }, WS, "")).statusCode).toBe(401);
    expect(c.store.get().workspaceSettings[WS]).toBeUndefined();
  });

  it("removes the image on null and keeps the sandbox flag", async () => {
    const c = await withWorkspace();
    await settings(c, "PUT", { image: "python:3.12-bookworm" });
    await c.store.update((d) => {
      d.workspaceSettings[WS] = { ...d.workspaceSettings[WS], sandbox: true };
    });
    const put = await settings(c, "PUT", { image: null });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ...view(c, { sandbox: true }), build: idle });
    expect(c.store.get().workspaceSettings[WS]).toEqual({ sandbox: true });

    await settings(c, "PUT", { image: "node:22" });
    expect((await settings(c, "PUT", { image: "  " })).json()).toEqual({ ...view(c, { sandbox: true }), build: idle });
  });

  it("rejects an invalid image, an unknown workspace and no login", async () => {
    const c = await withWorkspace();
    const bad = await settings(c, "PUT", { image: "bad image!" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "image: not a valid image reference" });
    expect((await settings(c, "PUT", { image: "node:22", extra: 1 })).statusCode).toBe(400);
    expect((await settings(c, "GET", undefined, "github~octo~nope")).statusCode).toBe(404);
    expect((await settings(c, "PUT", { image: "node:22" }, "github~octo~nope")).statusCode).toBe(404);
    expect((await settings(c, "GET", undefined, WS, "")).statusCode).toBe(401);
    expect((await settings(c, "PUT", { image: "node:22" }, WS, "")).statusCode).toBe(401);
  });
});
