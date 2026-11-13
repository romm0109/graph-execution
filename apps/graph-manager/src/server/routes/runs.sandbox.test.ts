// Starting a run in a sandbox through the API (KAN-88), against the fake Docker without exec: a started container
// writes the ready file and keeps "running".
import { cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { DockerClient } from "../docker.js";
import { DEFAULT_SANDBOX_IMAGE, Sandboxes, type ToolsMount } from "../sandbox.js";
import { containerRoot, toContainer } from "../sandbox-paths.js";
import { defaultRecipe, sandboxDockerfile, sandboxImageTag } from "../sandbox-image.js";
import { appWithLogin } from "../test-helpers.js";
import { homeAsWorkspace, resolveRunHome } from "../runhome.js";
import { resolveWorkspace } from "../workspaces.js";

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
    // On Windows the container sees the workspace at /workspaces/<rel> and runs as 1000:1000 (sandbox-paths.ts).
    const ws = resolveWorkspace(c.config.workspacesDir, WS)!;
    expect(ct.Config.User).toBe(process.platform === "win32" ? "1000:1000" : `${st.uid}:${st.gid}`);
    expect(ct.Config.WorkingDir).toBe(toContainer(ws, wsDir, process.platform));
    expect(ct.Config.Cmd.at(-1)).toBe("--web-serve");
    expect(ct.Config.Cmd).not.toContain("--web");
    expect(ct.HostConfig.Memory).toBe(8589934592);
    expect(ct.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: wsDir, Target: containerRoot(ws, process.platform) },
      { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true },
      { Type: "volume", Source: "gm-clis-test", Target: "/opt/gm-clis", ReadOnly: true },
    ]);
    expect(ct.Config.Env.filter((e) => e.startsWith("GM_"))).toEqual([]);
    expect(ct.Config.Env).toContain("GIT_AUTHOR_NAME=t");
    expect(ct.archives).toEqual([{ path: "/", names: ["home/sandbox/"] }]);
    // The reviewers (KAN-87) reach the sandbox through a copy in the run's folder: <dataDir> is not mounted.
    const copy = path.join(wsDir, ".graph-execution", runId, ".sandbox-reviewers.json");
    expect(ct.Config.Env).toContain(`GRAPH_EXECUTION_REVIEWERS=${toContainer(ws, copy, process.platform)}`);
    expect(await readFile(copy, "utf8")).toBe(await readFile(path.join(c.config.dataDir, "reviewers.json"), "utf8"));

    const data = c.store.get();
    expect(data.sandboxes[`${WS}/${runId}`]).toMatchObject({ runId, workspace: WS, container: ct.Id, name: `gm-run-${runId}`, image: "img:default", port: 7600 });
    expect(data.workspaceSettings[WS]?.sandbox).toBe(true);

    // A running sandbox blocks deleting its workspace.
    expect(await c.app.inject({ method: "DELETE", url: `/api/workspaces/${WS}`, headers: { cookie: c.cookie } })).toMatchObject({ statusCode: 409 });
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

describe("POST /api/runs/project~<id> with sandbox: true", () => {
  const HOME = "project~billing";

  /** Two git workspaces and the project folder linking them, as createProjectFolder (projects.ts) makes it. */
  async function project(c: NonNullable<typeof ctx>): Promise<{ projDir: string; repoDir: (n: string) => string }> {
    const repoDir = (n: string) => path.join(c.config.workspacesDir, "github", "acme", n);
    const git = (cwd: string, ...args: string[]) => execa("git", args, { cwd });
    for (const r of ["api", "web"]) {
      await mkdir(repoDir(r), { recursive: true });
      await git(repoDir(r), "init", "-q", "-b", "main");
    }
    const projDir = path.join(c.config.workspacesDir, ".projects", "billing");
    await mkdir(path.join(projDir, "repos"), { recursive: true });
    await git(projDir, "init", "-q", "-b", "main");
    await git(projDir, "config", "user.name", "t");
    await git(projDir, "config", "user.email", "t@example.com");
    for (const r of ["api", "web"]) await symlink(repoDir(r), path.join(projDir, "repos", r), process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      path.join(projDir, "project.json"),
      JSON.stringify({ name: "billing", repos: [{ name: "api", path: "repos/api" }, { name: "web", path: "repos/web" }] }),
    );
    await c.store.update((d) => {
      d.projects.billing = { name: "billing", workspaces: ["github~acme~api", "github~acme~web"], createdAt: "2026-11-13T00:00:00.000Z" };
    });
    return { projDir, repoDir };
  }

  it("starts a project run in its own container", async () => {
    const c = await setup();
    const { projDir, repoDir } = await project(c);
    const res = await c.app.inject({ method: "POST", url: `/api/runs/${HOME}`, headers: { cookie: c.cookie }, payload: { provider: "fake", sandbox: true } });
    expect(res.statusCode).toBe(201);
    const { runId, viewUrl } = res.json<{ runId: string; viewUrl: string }>();
    expect(runId).toMatch(/^suite-gm-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(viewUrl).toBe(`/runs/${HOME}/${runId}/view/`);

    const all = [...fake.containers.values()];
    expect(all).toHaveLength(1);
    const ct = all[0]!;
    const pf = process.platform;
    const homeWs = homeAsWorkspace(resolveRunHome(c.config.workspacesDir, c.store, HOME)!);
    const api = resolveWorkspace(c.config.workspacesDir, "github~acme~api")!;
    const web = resolveWorkspace(c.config.workspacesDir, "github~acme~web")!;
    expect(ct.Name).toBe(`/gm-run-${runId}`);
    expect(ct.Config.Labels).toEqual({ "gm.run": runId, "gm.workspace": HOME });
    expect(ct.Config.Cmd.slice(-6)).toEqual(["suite", "--project", ".", "--provider", "fake", "--web-serve"]);
    expect(ct.Config.Cmd).not.toContain("--web");
    expect(ct.Config.WorkingDir).toBe(toContainer(homeWs, projDir, pf));
    expect(ct.Config.Env).toContain(`GRAPH_EXECUTION_RUN_ID=${runId}`);
    const nested = (ws: typeof api, link: string) =>
      pf === "win32" ? [{ Type: "bind", Source: ws.path, Target: `${containerRoot(homeWs, pf)}/${link}` }] : [];
    expect(ct.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: projDir, Target: containerRoot(homeWs, pf) },
      { Type: "bind", Source: repoDir("api"), Target: containerRoot(api, pf) },
      ...nested(api, "repos/api"),
      { Type: "bind", Source: repoDir("web"), Target: containerRoot(web, pf) },
      ...nested(web, "repos/web"),
      { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true },
      { Type: "volume", Source: "gm-clis-test", Target: "/opt/gm-clis", ReadOnly: true },
    ]);
    const data = c.store.get();
    expect(data.sandboxes[`${HOME}/${runId}`]).toMatchObject({ runId, workspace: HOME, container: ct.Id, name: `gm-run-${runId}` });
    expect(data.workspaceSettings[HOME]?.sandbox).toBe(true);
    expect(data.runDefaults[HOME]).toMatchObject({ provider: "fake", tasksDir: "", spec: "" });

    // The suite writes its suite.json in the container; here by hand.
    const suiteDir = path.join(projDir, ".graph-execution", runId);
    const repo = (name: string) => ({ name, path: repoDir(name), startingCommit: "0".repeat(40), startBranch: "main" });
    await writeFile(
      path.join(suiteDir, "suite.json"),
      JSON.stringify({
        suiteId: runId,
        status: "running",
        provider: "fake",
        concurrency: 2,
        startingCommit: "0".repeat(40),
        merge: true,
        features: [{ name: "api", tasksDir: path.join(projDir, "tasks", "api"), prd: path.join(suiteDir, "specs", "api.md"), runId: "r1", status: "running", repo: repo("api") }],
        integration: { merged: [] },
        project: { dir: projDir, name: "billing", contract: path.join(projDir, "contract.md") },
        repos: [repo("api"), repo("web")],
        sandbox: { image: "img:default" },
        createdAt: "2026-11-13T12:00:00.000Z",
      }),
    );
    const runs = await c.app.inject({ method: "GET", url: `/api/runs?workspace=${HOME}`, headers: { cookie: c.cookie } });
    const listed = runs.json<{ runs: { id: string; sandbox?: { running: boolean } }[] }>().runs.find((r) => r.id === runId);
    expect(listed?.sandbox).toMatchObject({ running: true });
  });

  it("answers 409 when a repo of the project has no workspace", async () => {
    const c = await setup();
    await project(c);
    await c.store.update((d) => {
      d.projects.billing!.workspaces = ["github~acme~api"];
    });
    const res = await c.app.inject({ method: "POST", url: `/api/runs/${HOME}`, headers: { cookie: c.cookie }, payload: { provider: "fake", sandbox: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "repo web has no workspace" });
    expect(fake.containers.size).toBe(0);
  });
});
