import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import type { Config } from "./config.js";
import type { DockerClient } from "./docker.js";
import { SANDBOX_NETWORK, Sandboxes, type ToolsMount } from "./sandbox.js";
import { DEFAULT_RECIPE, defaultRecipe, sandboxDockerfile, sandboxImageTag } from "./sandbox-image.js";
import type { UserStore } from "./store.js";
import { tempDir, testConfig, testStore } from "./test-helpers.js";
import { resolveWorkspace } from "./workspaces.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: UserStore;
let instanceId: string;
const fakes: FakeDocker[] = [];
let savedHost: string | undefined;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  const t = await testStore();
  store = t.admin;
  instanceId = t.store.instance().instanceId;
  savedHost = process.env.HOSTNAME;
  process.env.HOSTNAME = "gmself000000";
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  if (savedHost === undefined) delete process.env.HOSTNAME;
  else process.env.HOSTNAME = savedHost;
  await cleanup();
});

async function fake(opts: Parameters<typeof startFakeDocker>[0] = {}): Promise<FakeDocker> {
  const f = await startFakeDocker(opts);
  fakes.push(f);
  return f;
}

/** Without the tools and image steps (sandbox-tools.test.ts and sandbox-image.test.ts cover them). */
class NoTools extends Sandboxes {
  protected override prepareTools(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  protected override async buildImages(): Promise<{ image: string; clisVolume: string }> {
    // The CLI volume start() checks for (review F5).
    await this.docker.createVolume("gm-clis-test");
    return { image: this.defaultImage(), clisVolume: "gm-clis-test" };
  }
}

/** Ready to start(): the tools mount is set and the image is known, without filling or building anything. */
class Ready extends Sandboxes {
  protected override prepareTools(): Promise<string | undefined> {
    (this as unknown as { mount: ToolsMount }).mount = { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
    return Promise.resolve(undefined);
  }
  protected override async buildImages(): Promise<{ image: string; clisVolume: string }> {
    await this.docker.createVolume("gm-clis-test");
    return { image: "img:1", clisVolume: "gm-clis-test" };
  }
}

function sandboxes(overrides: Partial<Config>): Sandboxes {
  return new NoTools({ config: testConfig(dir, overrides), store, instanceId, platform: "linux" });
}

/** The tag of the default recipe's image. */
const DEFAULT_TAG = sandboxImageTag(sandboxDockerfile(DEFAULT_RECIPE));

const SELF_ID = `gmself000000${"1".repeat(52)}`;

describe("Sandboxes", () => {
  it("on win32, mounts the workspace at /workspaces/<rel> and translates the paths", async () => {
    const f = await fake();
    const config = testConfig(dir, { dockerSocket: f.socketPath, sandboxImage: "img:1" });
    const wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
    await mkdir(wsDir, { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: wsDir });
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(path.join(config.dataDir, "reviewers.json"), '{"reviewers":[]}');
    const ws = resolveWorkspace(config.workspacesDir, "github~octo~hello")!;
    const s = new Ready({ config, store, instanceId, platform: "win32" });
    const ROOT = "/workspaces/github/octo/hello";

    // Resolves once the ready file is there, at the host path.
    const rec = await s.start({
      ws,
      cwd: ws.path,
      args: [path.join(ws.path, "diamond"), "--spec", path.join(ws.path, "spec.md"), "--provider", "fake"],
      runId: "r1",
      providers: ["fake"],
    });
    try {
      const ct = f.containers.get(rec.container)!;
      expect(ct.Config.User).toBe("1000:1000");
      expect(ct.Config.WorkingDir).toBe(ROOT);
      expect(ct.HostConfig.Mounts?.[0]).toEqual({ Type: "bind", Source: ws.path, Target: ROOT });
      expect(ct.Config.Cmd).toEqual([
        "node",
        "/opt/gm-tools/graph-execution/dist/cli.js",
        `${ROOT}/diamond`,
        "--spec",
        `${ROOT}/spec.md`,
        "--provider",
        "fake",
        "--web-serve",
      ]);
      expect(ct.Config.Env).toEqual(
        expect.arrayContaining([
          `GRAPH_EXECUTION_READY_FILE=${ROOT}/.graph-execution/r1/.ready.json`,
          `GRAPH_EXECUTION_REVIEWERS=${ROOT}/.graph-execution/r1/.sandbox-reviewers.json`,
          "GIT_CONFIG_KEY_0=safe.directory",
          "GIT_CONFIG_VALUE_0=*",
          "GIT_CONFIG_KEY_1=core.filemode",
          "GIT_CONFIG_VALUE_1=false",
        ]),
      );
      expect(ct.Config.Env.filter((e) => /^GIT_CONFIG_COUNT=[23]$/.test(e))).toHaveLength(1);
      const runDir = path.join(ws.path, ".graph-execution", "r1");
      expect(existsSync(path.join(runDir, ".ready.json"))).toBe(true);
      expect(existsSync(path.join(runDir, ".sandbox-reviewers.json"))).toBe(true);
    } finally {
      await s.stop(ws.id, "r1");
    }
  });

  it("does no I/O in the constructor", async () => {
    const f = await fake();
    sandboxes({ dockerSocket: f.socketPath });
    await new Promise((r) => setTimeout(r, 50));
    expect(f.requests).toEqual([]);
  });

  it("is available with the fake and creates the network once", async () => {
    const f = await fake();
    const s = sandboxes({ dockerSocket: f.socketPath });
    const [a, b] = await Promise.all([s.status(), s.init()]);
    expect(a).toEqual({ available: true, building: false, defaultImage: DEFAULT_TAG });
    expect(b).toBe(a);
    expect(f.networks.has(SANDBOX_NETWORK)).toBe(true);
    await s.init();
    expect(f.requests.filter((r) => r.path === "/networks/create")).toHaveLength(1);
    expect(f.requests.filter((r) => r.path === "/_ping")).toHaveLength(2);
    expect(f.requests.some((r) => r.path.endsWith("/connect"))).toBe(false);
    expect(s.self).toBeUndefined();
  });

  it("joins the network when graph-manager runs in a container, but does not use its image as the default", async () => {
    const f = await fake({ self: { id: SELF_ID, image: "graph-manager:1" } });
    const s = sandboxes({ dockerSocket: f.socketPath });
    expect(await s.status()).toEqual({ available: true, building: false, defaultImage: DEFAULT_TAG });
    const connect = f.requests.filter((r) => r.path === `/networks/${SANDBOX_NETWORK}/connect`);
    expect(connect).toHaveLength(1);
    expect(connect[0]?.body).toEqual({ Container: SELF_ID });
    expect(s.self?.Id).toBe(SELF_ID);
  });

  it("does not join again when already a member", async () => {
    const f = await fake({ self: { id: SELF_ID, networks: [SANDBOX_NETWORK] } });
    const s = sandboxes({ dockerSocket: f.socketPath });
    expect((await s.init()).available).toBe(true);
    expect(f.requests.some((r) => r.path.endsWith("/connect"))).toBe(false);
  });

  it("uses config.sandboxImage as the base of the default recipe", async () => {
    const f = await fake({ self: { id: SELF_ID, image: "graph-manager:1" } });
    const s = sandboxes({ dockerSocket: f.socketPath, sandboxImage: "img:1" });
    const tag = sandboxImageTag(sandboxDockerfile(defaultRecipe({ sandboxImage: "img:1" })));
    expect(tag).not.toBe(DEFAULT_TAG);
    expect(s.recipe().base).toBe("img:1");
    expect(await s.status()).toEqual({ available: true, building: false, defaultImage: tag });
    expect(s.defaultImage()).toBe(tag);
  });

  it("is unavailable when the socket is missing", async () => {
    const sock = path.join(os.tmpdir(), "gm-no-docker.sock");
    const s = sandboxes({ dockerSocket: sock });
    const st = await s.status();
    expect(st.available).toBe(false);
    expect(st.reason).toMatch(new RegExp(`^Docker is not reachable at ${sock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*ENOENT`));
    expect(st.reason).not.toContain("Docker Desktop");
    expect(await s.status()).toBe(st); // cached for 10 s
  });

  it.each([
    ["darwin", path.join(os.tmpdir(), "gm-no-docker.sock")],
    ["win32", "//./pipe/gm-test-missing"],
  ] as const)("asks for Docker Desktop when Docker is not reachable on %s", async (platform, sock) => {
    const s = new NoTools({ config: testConfig(dir, { dockerSocket: sock }), store, instanceId, platform });
    expect(s.platform).toBe(platform);
    const st = await s.status();
    expect(st.available).toBe(false);
    expect(st.reason?.startsWith(`Docker is not reachable at ${sock}: `)).toBe(true);
    expect(st.reason?.endsWith("; is Docker Desktop running?")).toBe(true);
  });

  it("is unavailable when Docker runs Windows containers", async () => {
    const f = await fake({ osType: "windows" });
    const s = sandboxes({ dockerSocket: f.socketPath });
    expect(await s.status()).toEqual({ available: false, reason: "Docker is running Windows containers: switch Docker Desktop to Linux containers" });
    expect(f.networks.size).toBe(0);
  });

  it("never takes itself for a container on macOS", async () => {
    const f = await fake({ self: { id: SELF_ID } });
    const s = new NoTools({ config: testConfig(dir, { dockerSocket: f.socketPath }), store, instanceId, platform: "darwin" });
    expect((await s.status()).available).toBe(true);
    expect(s.self).toBeUndefined();
    expect(f.requests.some((r) => r.path.endsWith("/connect"))).toBe(false);
  });

  it("takes the platform of the process by default", () => {
    expect(new NoTools({ config: testConfig(dir, {}), store, instanceId }).platform).toBe(process.platform);
  });
});

describe("Sandboxes.pageOf", () => {
  it("connects through the published port when graph-manager runs on the host, else through gm-sandbox", async () => {
    const config = testConfig(dir, {});
    const ws = path.join(config.workspacesDir, "github", "o", "r");
    await mkdir(path.join(ws, ".git"), { recursive: true });
    const running = {
      Id: "c1",
      Name: "/gm-run-r1",
      Config: { Image: "img", Hostname: "sbx-1" },
      State: { Status: "running", Running: true, ExitCode: 0 },
      NetworkSettings: { Networks: { [SANDBOX_NETWORK]: { IPAddress: "172.27.0.2" } }, Ports: { "7600/tcp": [{ HostIp: "127.0.0.1", HostPort: "55012" }] } },
    };
    const docker = { inspectContainer: () => Promise.resolve(running) } as unknown as DockerClient;
    await store.update((d) => {
      d.sandboxes["github~o~r/r1"] = { runId: "r1", workspace: "github~o~r", container: "c1", name: "gm-run-r1", host: "sbx-1", image: "img", port: 7600, token: "t", startedAt: "" };
    });
    const s = new Sandboxes({ config, store, instanceId, docker });
    const runDir = path.join(ws, ".graph-execution", "r1");
    expect((await s.pageOf(runDir))?.upstream).toEqual({ host: "127.0.0.1", port: 55012, hostPort: 7600, token: "t" });
    s.self = { ...running, Id: SELF_ID } as unknown as Sandboxes["self"];
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s inspect cache
    expect((await s.pageOf(runDir))?.upstream).toEqual({ host: "172.27.0.2", port: 7600, token: "t" });
  });

  it("finds the record of a project run (project~<id>) by the suite folder in the project", async () => {
    const config = testConfig(dir, {});
    const projDir = path.join(config.workspacesDir, ".projects", "billing");
    await mkdir(path.join(projDir, ".git"), { recursive: true });
    const running = {
      Id: "c2",
      Name: "/gm-run-suite-gm-1",
      Config: { Image: "img", Hostname: "sbx-2" },
      State: { Status: "running", Running: true, ExitCode: 0 },
      NetworkSettings: { Networks: { [SANDBOX_NETWORK]: { IPAddress: "172.27.0.3" } } },
    };
    const docker = { inspectContainer: () => Promise.resolve(running) } as unknown as DockerClient;
    await store.update((d) => {
      d.projects.billing = { name: "billing", workspaces: [], createdAt: "" };
      d.sandboxes["project~billing/suite-gm-1"] = { runId: "suite-gm-1", workspace: "project~billing", container: "c2", name: "gm-run-suite-gm-1", host: "sbx-2", image: "img", port: 7600, token: "t", startedAt: "" };
    });
    const s = new Sandboxes({ config, store, instanceId, docker });
    s.self = { ...running, Id: SELF_ID } as unknown as Sandboxes["self"];
    expect((await s.pageOf(path.join(projDir, ".graph-execution", "suite-gm-1")))?.upstream).toEqual({ host: "172.27.0.3", port: 7600, token: "t" });
    expect(await s.pageOf(path.join(projDir, ".graph-execution", "suite-gm-2"))).toBeUndefined();
  });
});
