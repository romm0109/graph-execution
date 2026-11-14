import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { DockerClient } from "../docker.js";
import { tempDir } from "../test-helpers.js";
import { agentContextEntries, agentDockerfile, agentImageTag, ensureAgentImage, ensureAgentVolume, ensureUserVolume, userVolumeName } from "./agent-image.js";

let fake: FakeDocker;
let docker: DockerClient;
let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeDocker();
  docker = new DockerClient(fake.socketPath);
  ({ dir, cleanup } = await tempDir());
  const files: Record<string, string> = {
    "server/cli.js": "console.log('gm')\n",
    "server/agent/server.js": "export {}\n",
    "engine/package.json": JSON.stringify({ name: "graph-execution", dependencies: { zod: "^4.0.0" }, devDependencies: { vitest: "1" } }),
    "engine/dist/cli.js": "#!/usr/bin/env node\n",
    "engine/dist/manager/server/cli.js": "bundled\n",
    "engine/dist/manager/cli.js": "kept\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
});
afterEach(async () => {
  await fake.close();
  await cleanup();
});

describe("agent runtime image", () => {
  it("builds a context of the server, the engine (without the bundled manager) and the engine's dependencies", async () => {
    const entries = await agentContextEntries(path.join(dir, "server"), path.join(dir, "engine"));
    expect(entries.map((e) => e.path)).toEqual([
      "Dockerfile",
      "package.json",
      "engine/package.json",
      "engine/dist/cli.js",
      "engine/dist/manager/cli.js",
      "server/agent/server.js",
      "server/cli.js",
    ]);
    expect(JSON.parse(entries[1]!.content!.toString())).toEqual({ name: "gm-agent", private: true, type: "module", dependencies: { zod: "^4.0.0" } });
    expect(agentDockerfile()).toContain("FROM node:24.22.1-bookworm\n");
    expect(agentDockerfile()).toContain("chown 1000:1000 /workspaces");
    // The tag depends on the content only.
    expect(agentImageTag(await agentContextEntries(path.join(dir, "server"), path.join(dir, "engine")))).toBe(agentImageTag(entries));
    expect(agentImageTag(entries)).toMatch(/^gm-agent:[0-9a-f]{12}$/);
  });

  it("builds the image once, fills its volume and makes a user's volume", async () => {
    const entries = await agentContextEntries(path.join(dir, "server"), path.join(dir, "engine"));
    const image = await ensureAgentImage(docker, entries, "inst");
    await ensureAgentImage(docker, entries, "inst");
    expect(fake.builds).toHaveLength(1);
    expect(fake.builds[0]).toMatchObject({ tag: image.tag, labels: { "gm.sandbox-image": "1", "gm.instance": "inst" } });
    const volume = await ensureAgentVolume(docker, image, "inst");
    expect(volume).toMatch(/^gm-agent-[0-9a-f]{12}$/);
    expect(fake.volumes.get(volume)?.Labels).toEqual({ "gm.agent": "1", "gm.instance": "inst" });
    const fills = fake.requests.filter((r) => r.path === "/containers/create");
    expect(fills.at(-1)?.body).toMatchObject({ Image: image.tag, Cmd: ["true"], HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: "/opt/gm-agent" }] } });

    const user = await ensureUserVolume(docker, image.tag, { id: "ann", name: "Ann" });
    expect(user).toBe(userVolumeName("ann"));
    expect(fake.volumes.get(user)?.Labels).toEqual({ "gm.user": "ann" });
    const before = fake.requests.length;
    await ensureUserVolume(docker, image.tag, { id: "ann", name: "Ann" });
    // An existing user volume is not filled again.
    expect(fake.requests.slice(before).some((r) => r.path === "/containers/create")).toBe(false);
  });
});
