import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import { DockerClient, DockerError, demuxLogs } from "./docker.js";

/** A minimal ustar archive of regular files. */
export function tarOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, "ascii");
    h.write("0000000\0", 108, "ascii");
    h.write("0000000\0", 116, "ascii");
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    h.write("00000000000\0", 136, "ascii");
    h.write("        ", 148, "ascii");
    h.write("0", 156, "ascii");
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

let fake: FakeDocker;
let docker: DockerClient;
beforeEach(async () => {
  fake = await startFakeDocker();
  docker = new DockerClient(fake.socketPath);
});
afterEach(async () => {
  await fake.close();
});

describe("DockerClient", () => {
  it("pings, with the API version prefix", async () => {
    await docker.ping();
    expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/_ping" });
  });

  it("creates, inspects, starts, lists, stops, waits for and removes a container", async () => {
    const id = await docker.createContainer("gm-run-1", {
      Image: "img:1",
      Labels: { "gm.run": "ws/run-1" },
      Env: ["A=1"],
      Cmd: ["sleep", "100"],
      HostConfig: { Memory: 4096 * 1024 * 1024 },
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const info = await docker.inspectContainer(id);
    expect(info?.Name).toBe("/gm-run-1");
    expect(info?.Config.Labels).toEqual({ "gm.run": "ws/run-1" });
    expect(info?.HostConfig?.Memory).toBe(4096 * 1024 * 1024);
    expect((await docker.inspectContainer("gm-run-1"))?.Id).toBe(id);
    await expect(docker.createContainer("gm-run-1", { Image: "img:1" })).rejects.toThrow(/already in use/);

    await docker.startContainer(id);
    await docker.startContainer(id); // 304: already started
    expect((await docker.inspectContainer(id))?.State.Running).toBe(true);
    const list = await docker.listContainers("gm.run");
    expect(list.map((c) => c.Id)).toEqual([id]);
    expect(list[0]?.Names).toEqual(["/gm-run-1"]);
    expect(await docker.listContainers("gm.run=other")).toEqual([]);
    expect(await docker.listContainers("gm.run=ws/run-1")).toHaveLength(1);

    const waited = docker.waitContainer(id);
    await docker.stopContainer(id, 1);
    expect(await waited).toBe(0);
    await docker.stopContainer(id); // 304: not running
    expect((await docker.inspectContainer(id))?.State.Status).toBe("exited");

    await docker.removeContainer(id);
    expect(await docker.inspectContainer(id)).toBeUndefined();
    await docker.removeContainer(id); // 404 is fine
    await docker.stopContainer(id); // 404 is fine
    expect(await docker.waitContainer(id)).toBe(-1);
    expect(fake.requests.every((r) => !r.path.startsWith("/v"))).toBe(true);
  });

  it("puts an archive", async () => {
    const id = await docker.createContainer("a", { Image: "img" });
    await docker.putArchive(id, "/", tarOf({ "opt/x.txt": "hello", "y.sh": "#!/bin/sh\n" }));
    expect(fake.containers.get(id)?.archives).toEqual([{ path: "/", names: ["opt/x.txt", "y.sh"] }]);
    const req = fake.requests.find((r) => r.method === "PUT");
    expect(req?.body).toEqual({ tarEntries: ["opt/x.txt", "y.sh"] });
  });

  it("reads and demultiplexes logs", async () => {
    const id = await docker.createContainer("l", { Image: "img" });
    const c = fake.containers.get(id);
    if (c) c.logs = "one\ntwo\nthree\n";
    expect(await docker.containerLogs(id)).toBe("one\ntwo\nthree\n");
    expect(await docker.containerLogs(id, 2)).toBe("two\nthree\n");
    expect(demuxLogs(Buffer.from("plain tty text"))).toBe("plain tty text");
    const frame = Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("err")]);
    expect(demuxLogs(frame)).toBe("err");
  });

  it("manages networks and volumes and checks images", async () => {
    expect(await docker.inspectNetwork("gm-sandbox")).toBeUndefined();
    await docker.createNetwork("gm-sandbox");
    expect((await docker.inspectNetwork("gm-sandbox"))?.Name).toBe("gm-sandbox");
    const id = await docker.createContainer("n", { Image: "img" });
    await docker.connectNetwork("gm-sandbox", id);
    await docker.connectNetwork("gm-sandbox", id); // already connected is fine
    expect(Object.keys((await docker.inspectContainer(id))?.NetworkSettings?.Networks ?? {})).toContain("gm-sandbox");

    expect(await docker.inspectVolume("gm-tools")).toBeUndefined();
    await docker.createVolume("gm-tools");
    expect((await docker.inspectVolume("gm-tools"))?.Name).toBe("gm-tools");

    expect(await docker.imageExists("img:1")).toBe(false);
  });

  it("finds a known image", async () => {
    const f = await startFakeDocker({ images: ["ghcr.io/o/img:1"] });
    try {
      const d = new DockerClient(f.socketPath);
      expect(await d.imageExists("ghcr.io/o/img:1")).toBe(true);
      expect(await d.imageExists("other")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("throws DockerError with status 0 when the socket does not exist", async () => {
    const d = new DockerClient(path.join(os.tmpdir(), "no-such-docker.sock"));
    const err = await d.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(0);
    expect((err as DockerError).message).toMatch(/ENOENT/);
  });

  it("inspects its own container by HOSTNAME", async () => {
    const saved = process.env.HOSTNAME;
    try {
      process.env.HOSTNAME = "abcdef123456";
      expect(await docker.inspectSelf()).toBeUndefined();
      const f = await startFakeDocker({ self: { id: `abcdef123456${"0".repeat(52)}`, image: "gm:2" } });
      try {
        const self = await new DockerClient(f.socketPath).inspectSelf();
        expect(self?.Config.Image).toBe("gm:2");
      } finally {
        await f.close();
      }
    } finally {
      if (saved === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = saved;
    }
  });
});

describe.skipIf(process.platform !== "linux")("fake docker exec mode", () => {
  it("runs the container's command as a local process", async () => {
    const f = await startFakeDocker({ exec: true });
    try {
      const d = new DockerClient(f.socketPath);
      const id = await d.createContainer("e", {
        Image: "img",
        Env: ["GRAPH_EXECUTION_WEB_HOST=0.0.0.0", "HOME=/home/u"],
        Cmd: ["node", "-e", "console.log(process.env.GRAPH_EXECUTION_WEB_HOST); console.log(require('fs').readFileSync(process.env.HOME + '/../../opt/x.txt', 'utf8')); process.exit(3)"],
      });
      await d.putArchive(id, "/", tarOf({ "opt/x.txt": "from tar" }));
      const ip = f.containers.get(id)?.ip;
      await d.startContainer(id);
      expect(await d.waitContainer(id)).toBe(3);
      expect(await d.containerLogs(id)).toBe(`${ip}\nfrom tar\n`);
    } finally {
      await f.close();
    }
  });
});
