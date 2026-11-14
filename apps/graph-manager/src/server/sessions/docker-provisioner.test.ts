import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { Config } from "../config.js";
import { DockerClient } from "../docker.js";
import type { WorkspaceHost } from "../host/types.js";
import { HostError } from "../host/types.js";
import type { User } from "../identity.js";
import { Sandboxes } from "../sandbox.js";
import type { SqlStore } from "../store.js";
import { appWithLogin, testConfig, testStore } from "../test-helpers.js";
import { DOCKER_SESSIONS_DOWN, DockerProvisioner, dockerSafeId } from "./docker-provisioner.js";
import type { SessionProvisioner } from "./provisioner.js";
import { chooseRuntime, RuntimeProvisioner } from "./runtime.js";

const ANN: User = { id: "ann", name: "Ann" };
const BOB: User = { id: "bob", name: "Bob" };
const TOOLS = { Type: "bind", Source: "/srv/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
const CLIS = { Type: "volume", Source: "gm-clis-test", Target: "/opt/gm-clis", ReadOnly: true };
const MISSING_SOCKET = path.join(os.tmpdir(), "gm-no-docker-here.sock");

interface Body {
  Image: string;
  User: string;
  Cmd: string[];
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: { Privileged?: boolean; SecurityOpt?: string[]; NanoCpus?: number; Memory?: number; PidsLimit?: number; Mounts: { Type: string; Source: string; Target: string; ReadOnly?: boolean }[] };
}

let fake: FakeDocker;
let docker: DockerClient;
let stores: SqlStore;
let config: Config;
let hosts: { url: string; token: string }[];

function provisionerOn(client: DockerClient): DockerProvisioner {
  const sandboxes = new Sandboxes({ config, store: undefined as never, instanceId: "test", docker: client });
  vi.spyOn(sandboxes, "status").mockResolvedValue({ available: true });
  vi.spyOn(sandboxes, "toolsMount").mockReturnValue(TOOLS);
  vi.spyOn(sandboxes, "clisMount").mockReturnValue(CLIS);
  vi.spyOn(sandboxes, "recipe").mockReturnValue({ base: "node:24.22.1-bookworm", toolchains: [], extraLines: "" });
  return new DockerProvisioner({
    config,
    store: stores,
    sandboxes,
    docker: client,
    agentRuntime: async () => ({ imageTag: "gm-agent:test", volume: "gm-agent-test" }),
    waitReady: async () => undefined,
    hostOf: (url, token) => {
      hosts.push({ url, token });
      return { kind: "remote", url } as unknown as WorkspaceHost;
    },
  });
}

const creates = (): { name: string; body: Body }[] =>
  fake.requests.filter((r) => r.method === "POST" && r.path === "/containers/create" && !String(r.query.name).startsWith("gm-fill-")).map((r) => ({ name: r.query.name ?? "", body: r.body as Body }));
const containerNamed = (name: string) => [...fake.containers.values()].find((c) => c.Name === `/${name}`);

describe("DockerProvisioner", () => {
  beforeEach(async () => {
    fake = await startFakeDocker({ images: ["gm-agent:test"] });
    docker = new DockerClient(fake.socketPath);
    ({ store: stores } = await testStore());
    config = testConfig(os.tmpdir());
    hosts = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.close();
  });

  it("starts gm-s-<sessionId> as 1000:1000 with the user's volume and a random token", async () => {
    const prov = provisionerOn(docker);
    await prov.acquire({ user: ANN, sessionId: "s1" });
    const made = creates();
    expect(made).toHaveLength(1);
    const { name, body } = made[0]!;
    expect(name).toBe("gm-s-s1");
    expect(body.Cmd).toEqual(["graph-manager", "agent", "--port", "7700", "--workspaces", "/workspaces"]);
    const tokenEnv = body.Env.find((e) => e.startsWith("GM_AGENT_TOKEN="));
    expect(tokenEnv).toMatch(/^GM_AGENT_TOKEN=[0-9a-f]{64}$/);
    expect(body.User).toBe("1000:1000");
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(body.HostConfig.Mounts.some((m) => m.Source.includes("docker.sock"))).toBe(false);
    expect(body.HostConfig.Mounts).toContainEqual({ Type: "volume", Source: `gm-user-${dockerSafeId("ann")}`, Target: "/workspaces" });
    expect(body.HostConfig.Mounts).toContainEqual(TOOLS);
    expect(body.HostConfig.Mounts).toContainEqual(CLIS);
    expect(body.HostConfig.Mounts).toContainEqual({ Type: "volume", Source: "gm-agent-test", Target: "/opt/gm-agent", ReadOnly: true });
    expect(body.Labels).toEqual({ "gm.session": "s1", "gm.user": "ann" });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.token).toBe(tokenEnv!.slice("GM_AGENT_TOKEN=".length));
    expect(hosts[0]!.url).toMatch(/^http:\/\/127\.0\.0\.\d+:7700$/);
    // HOME exists before start, owned by the session user.
    expect(containerNamed("gm-s-s1")?.archives[0]).toMatchObject({ path: "/", names: ["home/sandbox/"] });
    expect(fake.volumes.get(`gm-user-${dockerSafeId("ann")}`)?.Labels).toEqual({ "gm.user": "ann" });
  });

  it("re-attaches to a running session container with its own token", async () => {
    const prov = provisionerOn(docker);
    await prov.acquire({ user: ANN, sessionId: "s1" });
    await prov.acquire({ user: ANN, sessionId: "s1" });
    expect(creates()).toHaveLength(1);
    expect(hosts[1]!.token).toBe(hosts[0]!.token);
  });

  it("release removes the container and keeps the volume", async () => {
    const prov = provisionerOn(docker);
    await prov.acquire({ user: ANN, sessionId: "s1" });
    await prov.release({ user: ANN, sessionId: "s1" });
    expect(containerNamed("gm-s-s1")).toBeUndefined();
    expect(fake.volumes.has(`gm-user-${dockerSafeId("ann")}`)).toBe(true);
    // A second release of a gone container is fine.
    await prov.release({ user: ANN, sessionId: "s1" });
  });

  it("gives each user their own volume", async () => {
    const prov = provisionerOn(docker);
    await prov.acquire({ user: ANN, sessionId: "s1" });
    await prov.acquire({ user: BOB, sessionId: "s2" });
    const vols = creates().map((c) => c.body.HostConfig.Mounts.find((m) => m.Target === "/workspaces")?.Source);
    expect(vols).toEqual([`gm-user-${dockerSafeId("ann")}`, `gm-user-${dockerSafeId("bob")}`]);
    expect(dockerSafeId("admin")).toBe("admin-8c6976e5");
    expect(dockerSafeId("Ann@Example.com")).toMatch(/^ann-example.com-[0-9a-f]{8}$/);
    expect(dockerSafeId("Ann")).not.toBe(dockerSafeId("ann"));
    expect(dockerSafeId("--")).toMatch(/^u-[0-9a-f]{8}$/);
  });

  it("starts and releases a run container with the owner's limits and its own volume", async () => {
    const us = await stores.forUser(ANN);
    await us.update((d) => {
      d.sandboxLimits = { cpus: 1.5, memoryMb: 1024, pids: 300 };
    });
    const prov = provisionerOn(docker);
    await prov.acquireRun({ user: ANN, sessionId: "s1", runId: "r1" });
    const [made] = creates();
    expect(made!.name).toBe("gm-r-r1");
    expect(made!.body.Labels).toEqual({ "gm.run-container": "r1", "gm.session": "s1", "gm.user": "ann" });
    expect(made!.body.HostConfig).toMatchObject({ NanoCpus: 1.5e9, Memory: 1024 * 1024 * 1024, PidsLimit: 300 });
    expect(made!.body.HostConfig.Mounts).toContainEqual({ Type: "volume", Source: "gm-r-r1", Target: "/workspaces" });
    expect(fake.volumes.get("gm-r-r1")?.Labels).toEqual({ "gm.run-container": "r1" });

    await prov.acquireRun({ user: ANN, sessionId: "s1", runId: "r1" });
    expect(creates()).toHaveLength(1);

    await prov.releaseRun({ user: ANN, runId: "r1" });
    expect(containerNamed("gm-r-r1")).toBeUndefined();
    expect(fake.volumes.has("gm-r-r1")).toBe(false);
  });

  it("removes a user's containers", async () => {
    const prov = provisionerOn(docker);
    await prov.acquire({ user: ANN, sessionId: "s1" });
    await prov.acquireRun({ user: ANN, sessionId: "s1", runId: "r1" });
    await prov.acquire({ user: BOB, sessionId: "s2" });
    await prov.releaseUser("ann");
    expect([...fake.containers.values()].map((c) => c.Name)).toEqual(["/gm-s-s2"]);
    expect(fake.volumes.has(`gm-user-${dockerSafeId("ann")}`)).toBe(true);
  });

  it("removes the container and answers 502 with its logs when the agent does not come up", async () => {
    const prov = provisionerOn(docker);
    (prov as unknown as { opts: { waitReady: () => Promise<void> } }).opts.waitReady = async () => {
      throw new Error("boom");
    };
    const err = await prov.acquire({ user: ANN, sessionId: "s1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).status).toBe(502);
    expect(containerNamed("gm-s-s1")).toBeUndefined();
  });

  it("answers 503 with the exact message when Docker is down", async () => {
    const prov = provisionerOn(new DockerClient(MISSING_SOCKET));
    const err = await prov.acquire({ user: ANN, sessionId: "s1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).status).toBe(503);
    expect((err as HostError).message).toBe(DOCKER_SESSIONS_DOWN);
  });
});

describe("RuntimeProvisioner", () => {
  it("chooses local with one account and docker with two or more under auto", () => {
    expect(chooseRuntime("auto", 1)).toBe("local");
    expect(chooseRuntime("auto", 2)).toBe("docker");
    expect(chooseRuntime("local", 5)).toBe("local");
    expect(chooseRuntime("docker", 1)).toBe("docker");
  });

  it("releases a session through the provisioner that acquired it", async () => {
    const calls: string[] = [];
    const fakeProv = (name: string): SessionProvisioner => ({
      acquire: async () => {
        calls.push(`${name}.acquire`);
        return {} as WorkspaceHost;
      },
      release: async () => void calls.push(`${name}.release`),
      acquireRun: async () => {
        calls.push(`${name}.acquireRun`);
        return {} as WorkspaceHost;
      },
      releaseRun: async () => void calls.push(`${name}.releaseRun`),
    });
    let accounts = 1;
    const rp = new RuntimeProvisioner({ setting: "auto", countUsers: async () => accounts, local: fakeProv("local"), docker: fakeProv("docker") });
    await rp.acquire({ user: ANN, sessionId: "a" });
    accounts = 2;
    await rp.acquire({ user: ANN, sessionId: "b" });
    // A live local session stays local after the second account appears.
    await rp.acquire({ user: ANN, sessionId: "a" });
    await rp.release({ user: ANN, sessionId: "a" });
    await rp.acquireRun({ user: ANN, sessionId: "b", runId: "r" });
    await rp.releaseRun({ user: ANN, runId: "r" });
    await rp.release({ user: ANN, sessionId: "b" });
    expect(calls).toEqual([
      "local.acquire",
      "docker.acquire",
      "local.acquire",
      "local.release",
      "docker.acquireRun",
      "docker.releaseRun",
      "docker.release",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("POST /api/sessions and GM_SESSION_RUNTIME", () => {
  let forge: FakeForge;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    forge = await startFakeForge();
  });
  afterAll(async () => {
    await forge.close();
  });
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function open(overrides: Partial<Config>) {
    const res = await appWithLogin({ githubApiUrl: `${forge.url}/github`, dockerSocket: MISSING_SOCKET, ...overrides });
    cleanup = res.cleanup;
    const req = (method: "POST" | "PUT", url: string, payload: object) => res.app.inject({ method, url, payload, headers: { cookie: res.cookie } });
    expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
    return req("POST", "/api/sessions", { repo: { forge: "github", owner: "octo", name: "hello" }, branch: { new: "gm/x" } });
  }

  it("answers 503 in docker mode without Docker", async () => {
    const res = await open({ sessionRuntime: "docker" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(JSON.stringify({ error: DOCKER_SESSIONS_DOWN }));
  });

  it("opens a local session under auto with one account, without Docker", async () => {
    const res = await open({});
    expect(res.statusCode, res.body).toBe(201);
  });
});
