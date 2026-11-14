// End to end with a REAL Docker daemon (hosted sessions): a session container from the agent runtime image, reached
// through its RemoteWorkspaceHost. Skipped unless on Linux with a daemon on /var/run/docker.sock, the base image
// present locally (the test never pulls) and graph-manager built (dist/server/cli.js).
//   docker pull node:24.22.1-bookworm && npm run build -w graph-manager && npm test -w graph-manager -- docker-provisioner.docker
import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defaultGraphExecutionBin } from "../config.js";
import { DockerClient } from "../docker.js";
import type { User } from "../identity.js";
import { SANDBOX_NETWORK, Sandboxes } from "../sandbox.js";
import { testConfig, testStore } from "../test-helpers.js";
import { agentVolumeName, userVolumeName } from "./agent-image.js";
import { DockerProvisioner } from "./docker-provisioner.js";

const SOCKET = "/var/run/docker.sock";
const IMAGE = "node:24.22.1-bookworm";
const SERVER_DIR = fileURLToPath(new URL("../../../dist/server/", import.meta.url));
const docker = new DockerClient(SOCKET);
const linux = process.platform === "linux";
const reachable = linux && (await docker.ping().then(() => true, () => false));
const hasImage = reachable && (await docker.imageExists(IMAGE).catch(() => false));
const built = existsSync(`${SERVER_DIR}cli.js`) && existsSync(defaultGraphExecutionBin());
const missing = !linux
  ? "not on Linux"
  : !reachable
    ? `no Docker daemon on ${SOCKET}`
    : !hasImage
      ? `the image ${IMAGE} is not present locally (docker pull ${IMAGE})`
      : !built
        ? "graph-manager or graph-execution is not built (npm run build)"
        : undefined;
if (missing) console.warn(`skipping the real-Docker session test: ${missing}`);

const USER: User = { id: `gm-test-${process.pid}`, name: "test" };
const TOOLS_VOLUME = `gm-test-tools-${process.pid}`;
const CLIS_VOLUME = `gm-test-clis-${process.pid}`;
let agentImage: string | undefined;

afterAll(async () => {
  if (missing) return;
  for (const v of [userVolumeName(USER.id), TOOLS_VOLUME, CLIS_VOLUME]) await docker.removeVolume(v).catch(() => undefined);
  if (agentImage) {
    const info = await docker.inspectImage(agentImage).catch(() => undefined);
    if (info) await docker.removeVolume(agentVolumeName(info.Id)).catch(() => undefined);
    await docker.removeImage(agentImage).catch(() => undefined);
  }
});

describe.skipIf(!!missing)("DockerProvisioner with real Docker", () => {
  it("runs the agent as 1000 in gm-s-<id>, and release keeps the volume", { timeout: 15 * 60_000 }, async () => {
    if (!(await docker.inspectNetwork(SANDBOX_NETWORK))) await docker.createNetwork(SANDBOX_NETWORK);
    const config = testConfig(os.tmpdir(), { graphExecutionBin: defaultGraphExecutionBin(), dockerSocket: SOCKET });
    const { store, admin } = await testStore();
    // The sessions' sandbox image is the plain Node image here; the tools and CLIs are empty volumes.
    await (await store.forUser(USER)).update((d) => {
      d.sandboxRecipe = { base: IMAGE, toolchains: [], extraLines: "" };
    });
    const sandboxes = new Sandboxes({ config, store: admin, instanceId: "gm-test", docker });
    vi.spyOn(sandboxes, "status").mockResolvedValue({ available: true });
    vi.spyOn(sandboxes, "imageForData").mockReturnValue({ source: "image", image: IMAGE });
    vi.spyOn(sandboxes, "toolsMount").mockReturnValue({ Type: "volume", Source: TOOLS_VOLUME, Target: "/opt/gm-tools", ReadOnly: true });
    vi.spyOn(sandboxes, "clisMount").mockReturnValue({ Type: "volume", Source: CLIS_VOLUME, Target: "/opt/gm-clis", ReadOnly: true });
    const prov = new DockerProvisioner({ config, store, sandboxes, docker, serverDir: SERVER_DIR });

    const sessionId = `t${process.pid}`;
    const host = await prov.acquire({ user: USER, sessionId });
    agentImage = (await docker.inspectContainer(`gm-s-${sessionId}`))?.Config.Image;
    try {
      expect(await host.activity()).toBeDefined();
      // A workspace to run in, made by the session user.
      const id = await docker.createContainer(`gm-test-ws-${process.pid}`, {
        Image: IMAGE,
        User: "1000:1000",
        Cmd: ["sh", "-c", "mkdir -p /workspaces/github/octo/hello && git init -q /workspaces/github/octo/hello"],
        HostConfig: { Mounts: [{ Type: "volume", Source: userVolumeName(USER.id), Target: "/workspaces" }] },
      });
      await docker.startContainer(id);
      expect(await docker.waitContainer(id)).toBe(0);
      await docker.removeContainer(id);

      const pty = await host.spawnPty({ workspaceId: "github~octo~hello", argv: ["sh", "-c", "id -u; ls -ld /workspaces"], env: {}, cols: 80, rows: 24 });
      let out = "";
      pty.onData((d) => (out += d));
      await new Promise<void>((resolve) => pty.onExit(() => resolve()));
      expect(out).toMatch(/^1000\s*$/m);
    } finally {
      await prov.release({ user: USER, sessionId });
    }
    expect(await docker.inspectContainer(`gm-s-${sessionId}`)).toBeUndefined();
    expect(await docker.inspectVolume(userVolumeName(USER.id))).toBeDefined();
  });
});
