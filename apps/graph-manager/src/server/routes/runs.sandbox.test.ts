// Starting a run in a sandbox through the API (KAN-88), against the fake Docker without exec: a started container
// writes the ready file and keeps "running".
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { DockerClient } from "../docker.js";
import { DEFAULT_SANDBOX_IMAGE, Sandboxes, type ToolsMount } from "../sandbox.js";
import { defaultRecipe, sandboxDockerfile, sandboxImageTag } from "../sandbox-image.js";
import { appWithLogin } from "../test-helpers.js";

const FIXTURES = fileURLToPath(new URL("../../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const WS = "github~octo~hello";
const START = { tasksDir: "diamond", spec: "spec.md", provider: "fake", sandbox: true };

let fake: FakeDocker;
let ctx: Awaited<ReturnType<typeof appWithLogin>> | undefined;
let wsDir: string;

async function setup(overrides: Parameters<typeof appWithLogin>[0] = {}): Promise<NonNullable<typeof ctx>> {
  ctx = await appWithLogin({ dockerSocket: fake.socketPath, sandboxImage: "img:default", ...overrides });
  wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  const git = (...args: string[]) => execa("git", args, { cwd: wsDir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@example.com");
  await cp(path.join(FIXTURES, "diamond"), path.join(wsDir, "diamond"), { recursive: true });
  await cp(path.join(FIXTURES, "spec.md"), path.join(wsDir, "spec.md"));
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  return ctx;
}

function start(c: NonNullable<typeof ctx>, body: unknown = START) {
  return c.app.inject({ method: "POST", url: `/api/runs/${WS}`, headers: { cookie: c.cookie }, payload: body });
}

beforeEach(async () => {
  fake = await startFakeDocker();
  // The tools step is covered by sandbox-tools.test.ts: pretend it filled /tmp/gm-tools.
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
    // The CLI volume start() checks for (review F5); empty is enough for the fake provider.
    await (this as unknown as { docker: { createVolume(n: string): Promise<unknown> } }).docker.createVolume("gm-clis-test");
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ctx?.cleanup();
  ctx = undefined;
  await fake.close();
});

describe("POST /api/runs/:ws with sandbox: true", () => {
  it("starts the run in its own container", async () => {
    const c = await setup();
    await c.store.update((d) => {
      d.sandboxLimits.memoryMb = 8192;
    });
    const res = await start(c);
    expect(res.statusCode).toBe(201);
    const { runId, viewUrl } = res.json<{ runId: string; viewUrl: string }>();
    expect(viewUrl).toBe(`/runs/${WS}/${runId}/view/`);

    const all = [...fake.containers.values()];
    expect(all).toHaveLength(1);
    const ct = all[0]!;
    expect(ct.Name).toBe(`/gm-run-${runId}`);
    expect(ct.Config.Labels).toEqual({ "gm.run": runId, "gm.workspace": WS });
    expect(ct.Config.Image).toBe("img:default");
    const st = await stat(wsDir);
    expect(ct.Config.User).toBe(`${st.uid}:${st.gid}`);
    expect(ct.Config.WorkingDir).toBe(wsDir);
    expect(ct.Config.Cmd.at(-1)).toBe("--web-serve");
    expect(ct.Config.Cmd).not.toContain("--web");
    expect(ct.HostConfig.Memory).toBe(8589934592);
    expect(ct.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: wsDir, Target: wsDir },
      { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true },
      { Type: "volume", Source: "gm-clis-test", Target: "/opt/gm-clis", ReadOnly: true },
    ]);
    expect(ct.Config.Env.filter((e) => e.startsWith("GM_"))).toEqual([]);
    expect(ct.Config.Env).toContain("GIT_AUTHOR_NAME=t");
    expect(ct.archives).toEqual([{ path: "/", names: ["home/sandbox/"] }]);
    // The reviewers (KAN-87) reach the sandbox through a copy in the run's folder: <dataDir> is not mounted.
    const copy = path.join(wsDir, ".graph-execution", runId, ".sandbox-reviewers.json");
    expect(ct.Config.Env).toContain(`GRAPH_EXECUTION_REVIEWERS=${copy}`);
    expect(await readFile(copy, "utf8")).toBe(await readFile(path.join(c.config.dataDir, "reviewers.json"), "utf8"));

    const data = c.store.get();
    expect(data.sandboxes[`${WS}/${runId}`]).toMatchObject({ runId, workspace: WS, container: ct.Id, name: `gm-run-${runId}`, image: "img:default", port: 7600 });
    expect(data.workspaceSettings[WS]?.sandbox).toBe(true);

    // A running sandbox blocks deleting its workspace.
    expect(await c.app.inject({ method: "DELETE", url: `/api/workspaces/${WS}`, headers: { cookie: c.cookie } })).toMatchObject({ statusCode: 409 });
  });

  it("copies the logins of the run provider and the review provider", async () => {
    // A claude login, whatever the machine has: CI runners have none, and a missing login answers 400.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const c = await setup();
    const spy = vi.spyOn(Sandboxes.prototype, "start");
    expect((await start(c, { ...START, options: { reviewProvider: "claude" } })).statusCode).toBe(201);
    expect(spy.mock.calls[0]![0].providers).toEqual(["fake", "claude"]);
    expect((await start(c, { ...START, options: { reviewProvider: "fake" } })).statusCode).toBe(201);
    expect(spy.mock.calls[1]![0].providers).toEqual(["fake"]);
  });

  it("uses the workspace's image", async () => {
    const c = await setup();
    await c.store.update((d) => {
      d.workspaceSettings[WS] = { image: "img:ws" };
    });
    expect((await start(c)).statusCode).toBe(201);
    expect([...fake.containers.values()][0]?.Config.Image).toBe("img:ws");
  });

  it("saving a recipe whose image exists after a failed build clears the failure without queueing a build (T4)", async () => {
    const c = await setup();
    expect((await c.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: c.cookie } })).json()).toMatchObject({ available: true });
    const put = (recipe: unknown) =>
      c.app.inject({ method: "PUT", url: `/api/workspaces/${WS}/settings`, headers: { cookie: c.cookie }, payload: { source: "recipe", recipe } });
    const build = async () =>
      (await c.app.inject({ method: "GET", url: `/api/workspaces/${WS}/sandbox/build`, headers: { cookie: c.cookie } })).json<{ state: string }>();
    const settle = async () => {
      for (let i = 0; i < 200 && ["queued", "building"].includes((await build()).state); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const good = { ...defaultRecipe({}), base: "node:22-bookworm" };
    expect((await put(good)).statusCode).toBe(200);
    await settle();
    expect((await build()).state).toBe("ready");
    expect((await put({ ...good, extraLines: "RUN echo FAKE_BUILD_FAIL" })).statusCode).toBe(200);
    await settle();
    expect((await build()).state).toBe("failed");
    const builds = fake.builds.length;
    const res = await put(good);
    expect(res.json<{ build: { state: string } }>().build.state).toBe("idle");
    expect((await build()).state).toBe("idle");
    expect(fake.builds.length).toBe(builds);
  });

  it("answers 409 while the workspace's own recipe image builds, then uses it", async () => {
    const c = await setup();
    let release = (): void => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const real = DockerClient.prototype.buildImage;
    vi.spyOn(DockerClient.prototype, "buildImage").mockImplementation(async function (this: DockerClient, ...args: Parameters<DockerClient["buildImage"]>) {
      await hold;
      return real.apply(this, args);
    });
    // The global build first (mocked); the workspace build still makes sure the CLI image and its volume exist (T1).
    expect((await c.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: c.cookie } })).json()).toMatchObject({ available: true });
    const recipe = { ...defaultRecipe({}), base: "node:22-bookworm", extraLines: "RUN true" };
    const put = await c.app.inject({ method: "PUT", url: `/api/workspaces/${WS}/settings`, headers: { cookie: c.cookie }, payload: { source: "recipe", recipe } });
    expect(put.statusCode).toBe(200);
    const res = await start(c);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "the sandbox image of this workspace is building; try again when it is ready" });
    expect(fake.containers.size).toBe(0);

    release();
    const build = () => c.app.inject({ method: "GET", url: `/api/workspaces/${WS}/sandbox/build`, headers: { cookie: c.cookie } });
    for (let i = 0; i < 200 && (await build()).json<{ state: string }>().state !== "ready"; i++) await new Promise((r) => setTimeout(r, 25));
    expect((await build()).json<{ state: string }>().state).toBe("ready");
    expect((await start(c)).statusCode).toBe(201);
    const ct = [...fake.containers.values()][0];
    expect(ct?.Config.Image).toBe(sandboxImageTag(sandboxDockerfile(recipe)));
    // The mocked global build named a volume Docker doesn't have: the workspace build created a real one.
    const clis = ct?.HostConfig.Mounts?.find((m) => m.Target === "/opt/gm-clis");
    expect(clis).toMatchObject({ Type: "volume", ReadOnly: true });
    expect(clis?.Source).toMatch(/^gm-clis-[0-9a-f]{12}$/);
    expect(fake.volumes.has(clis!.Source)).toBe(true);
  });

  it("answers 400 when Docker is not reachable", async () => {
    const c = await setup({ dockerSocket: "/nonexistent.sock" });
    const res = await start(c);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/^Docker is not reachable/);
  });

  it("pulls the default image when none is set", async () => {
    const c = await setup({ sandboxImage: undefined });
    const res = await start(c);
    expect(res.statusCode).toBe(201);
    expect(fake.requests.some((r) => r.method === "POST" && r.path === "/images/create" && r.query.fromImage === DEFAULT_SANDBOX_IMAGE)).toBe(true);
    expect([...fake.containers.values()][0]?.Config.Image).toBe(DEFAULT_SANDBOX_IMAGE);
  });

  it("answers 400 when the image cannot be pulled", async () => {
    const c = await setup({ sandboxImage: "img:missing" });
    const res = await start(c);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/^cannot pull the sandbox image img:missing: manifest for img:missing not found/);
    expect(fake.containers.size).toBe(0);
  });

  it("answers 400 with the logs and removes the container when the page is not ready in time", async () => {
    const c = await setup();
    // A container that never writes the ready file.
    const create = DockerClient.prototype.createContainer;
    vi.spyOn(DockerClient.prototype, "createContainer").mockImplementation(function (this: DockerClient, name: string, body: object) {
      const b = body as { Env: string[] };
      return create.call(this, name, { ...b, Env: b.Env.filter((e) => !e.startsWith("GRAPH_EXECUTION_READY_FILE=")) });
    });
    const startSandbox = Sandboxes.prototype.start;
    vi.spyOn(Sandboxes.prototype, "start").mockImplementation(function (this: Sandboxes, p) {
      return startSandbox.call(this, { ...p, readyTimeoutMs: 500 });
    });
    const res = await start(c);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("the sandbox did not start within 60 s");
    expect(fake.containers.size).toBe(0);
    expect(c.store.get().sandboxes).toEqual({});
  });

  it("answers 400 with the exit code and the logs when the container exits during startup", async () => {
    // Exec mode: the container runs its Cmd, and /opt/gm-tools is not there, so node exits at once and the
    // fake's wait answers right away. The watcher must not remove the container before its logs are read.
    await fake.close();
    fake = await startFakeDocker({ exec: true });
    const c = await setup();
    const res = await start(c);
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; output?: string }>();
    expect(body.error).toBe("the sandbox exited with code 1");
    expect(body.output).toMatch(/Cannot find module/);
    expect(fake.containers.size).toBe(0);
    expect(c.store.get().sandboxes).toEqual({});
  });
});
