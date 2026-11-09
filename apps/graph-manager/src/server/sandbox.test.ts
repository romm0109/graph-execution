import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import type { Config } from "./config.js";
import type { DockerClient } from "./docker.js";
import { SANDBOX_NETWORK, Sandboxes } from "./sandbox.js";
import { DEFAULT_RECIPE, defaultRecipe, sandboxDockerfile, sandboxImageTag } from "./sandbox-image.js";
import { DataStore } from "./store.js";
import { tempDir, testConfig } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: DataStore;
const fakes: FakeDocker[] = [];
let savedHost: string | undefined;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  store = await DataStore.open(path.join(dir, "data"));
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

function sandboxes(overrides: Partial<Config>): Sandboxes {
  return new NoTools({ config: testConfig(dir, overrides), store });
}

/** The tag of the default recipe's image. */
const DEFAULT_TAG = sandboxImageTag(sandboxDockerfile(DEFAULT_RECIPE));

const SELF_ID = `gmself000000${"1".repeat(52)}`;

describe("Sandboxes", () => {
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
    expect(await s.status()).toBe(st); // cached for 10 s
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
    const s = new Sandboxes({ config, store, docker });
    const runDir = path.join(ws, ".graph-execution", "r1");
    expect((await s.pageOf(runDir))?.upstream).toEqual({ host: "127.0.0.1", port: 55012, hostPort: 7600, token: "t" });
    s.self = { ...running, Id: SELF_ID } as unknown as Sandboxes["self"];
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s inspect cache
    expect((await s.pageOf(runDir))?.upstream).toEqual({ host: "172.27.0.2", port: 7600, token: "t" });
  });
});
