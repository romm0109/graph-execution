import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import { defaultGraphExecutionBin } from "./config.js";
import { Sandboxes } from "./sandbox.js";
import { engineDirOf, fillTools } from "./sandbox-tools.js";
import { DataStore } from "./store.js";
import { tempDir, testConfig } from "./test-helpers.js";

const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
if (!built) console.warn(`skipping the sandbox tools tests: ${BIN} is missing; run \`npm run build -w graph-execution\` first`);

const SELF_HOST = "gmself000000";
const SELF_ID = `${SELF_HOST}${"1".repeat(52)}`;

let dir: string;
let cleanup: () => Promise<void>;
const fakes: FakeDocker[] = [];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("gm-tools-"));
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  await cleanup();
});

async function engineVersion(): Promise<string> {
  const engineDir = engineDirOf(BIN);
  if (!engineDir) throw new Error("no engine");
  return (JSON.parse(await readFile(path.join(engineDir, "package.json"), "utf8")) as { version: string }).version;
}

describe("fillTools", () => {
  it.skipIf(!built)(
    "copies the engine with its dependencies and a wrapper, and skips a fresh folder",
    async () => {
      const tools = path.join(dir, "tools");
      const engineDir = engineDirOf(BIN);
      expect(engineDir).toBeDefined();
      expect(await fillTools(tools, { engineDir: engineDir as string, gmVersion: "t" })).toBe("filled");
      const wrapper = path.join(tools, "bin", "graph-execution");
      // The wrapper runs in a Linux container: no CRLF, on any host.
      expect(readFileSync(wrapper, "utf8")).not.toContain("\r");
      const version = await engineVersion();
      const out = await execa(wrapper, ["--version"], { env: { PATH: process.env.PATH }, extendEnv: false });
      expect(out.stdout.trim()).toContain(version);
      expect(existsSync(path.join(tools, "graph-execution", "node_modules", "zod", "package.json"))).toBe(true);
      expect(existsSync(path.join(tools, "graph-execution", "node_modules", "commander", "package.json"))).toBe(true);
      // The bundled graph-manager and what only it needs stay out of a sandbox.
      for (const absent of [["node_modules", "fastify"], ["node_modules", "node-pty"], ["dist", "manager", "server"], ["dist", "manager", "web"], ["dist", "manager", "package.json"]]) {
        expect(existsSync(path.join(tools, "graph-execution", ...absent))).toBe(false);
      }
      // The engine's own files in dist/manager are copied (cli.js imports them); `manager` says what is missing.
      const manager = await execa("node", [path.join(tools, "graph-execution", "dist", "cli.js"), "manager", "--no-open"], { cwd: os.tmpdir(), reject: false });
      expect(manager.exitCode).toBe(2);
      expect(manager.stderr).toContain("graph-manager is not part of this build");
      expect(existsSync(path.join(tools, "VERSION"))).toBe(true);
      expect((await readdir(tools)).filter((e) => e.startsWith(".next-"))).toEqual([]);

      // Self-contained: runs from a cwd outside the repo.
      const outside = await execa("node", [path.join(tools, "graph-execution", "dist", "cli.js"), "--version"], { cwd: os.tmpdir() });
      expect(outside.stdout.trim()).toContain(version);

      const mtime = statSync(wrapper).mtimeMs;
      expect(await fillTools(tools, { engineDir: engineDir as string, gmVersion: "t" })).toBe("fresh");
      expect(statSync(wrapper).mtimeMs).toBe(mtime);
    },
    60_000,
  );

  it.skipIf(!built)(
    "removes the provider CLIs copied by older versions",
    async () => {
      const tools = path.join(dir, "tools");
      const engineDir = engineDirOf(BIN) as string;
      await mkdir(path.join(tools, "lib", "claude"), { recursive: true });
      await writeFile(path.join(tools, "lib", "claude", "claude"), "old");
      expect(await fillTools(tools, { engineDir, gmVersion: "t" })).toBe("filled");
      expect(existsSync(path.join(tools, "lib"))).toBe(false);
      // A fresh folder loses it as well.
      await mkdir(path.join(tools, "lib", "claude"), { recursive: true });
      expect(await fillTools(tools, { engineDir, gmVersion: "t" })).toBe("fresh");
      expect(existsSync(path.join(tools, "lib"))).toBe(false);
    },
    60_000,
  );
});

describe("Sandboxes tools", () => {
  let savedHost: string | undefined;
  beforeEach(() => {
    savedHost = process.env.HOSTNAME;
    // The image step is covered by sandbox-image.test.ts.
    vi.spyOn(Sandboxes.prototype as unknown as { buildImages: () => Promise<{ image: string; clisVolume: string }> }, "buildImages").mockImplementation(async function (
      this: { opts: { config: { sandboxImage?: string } } },
    ) {
      // The built image is the recipe's base here: these tests start containers of a known image.
    // The CLI volume start() checks for (review F5); empty is enough for the fake provider.
    await (this as unknown as { docker: { createVolume(n: string): Promise<unknown> } }).docker.createVolume("gm-clis-test");
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHost === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = savedHost;
  });

  async function sandboxes(fakeOpts: Parameters<typeof startFakeDocker>[0], overrides: Parameters<typeof testConfig>[1] = {}): Promise<Sandboxes> {
    const f = await startFakeDocker(fakeOpts);
    fakes.push(f);
    const config = testConfig(dir, { dockerSocket: f.socketPath, graphExecutionBin: BIN, ...overrides });
    const store = await DataStore.open(config.dataDir);
    return new Sandboxes({ config, store, platform: "linux" });
  }

  it("is unavailable when the engine is not found", async () => {
    const s = await sandboxes({}, { graphExecutionBin: "graph-execution" });
    const st = await s.status();
    expect(st.available).toBe(false);
    expect(st.reason).toBe("the graph-execution engine was not found next to graph-manager (GM_GRAPH_EXECUTION_BIN=graph-execution)");
    expect(s.toolsMount()).toBeUndefined();
  });

  it.skipIf(!built)(
    "fills <dataDir>/sandbox-tools and bind-mounts it outside Docker",
    async () => {
      const s = await sandboxes({});
      expect((await s.status()).available).toBe(true);
      const folder = path.join(dir, "data", "sandbox-tools");
      expect(s.toolsDir()).toBe(folder);
      expect(s.toolsMount()).toEqual({ Type: "bind", Source: folder, Target: "/opt/gm-tools", ReadOnly: true });
      expect(existsSync(path.join(folder, "bin", "graph-execution"))).toBe(true);
    },
    60_000,
  );

  it.skipIf(!built)("in Docker without the tools volume, is unavailable with an actionable reason", async () => {
    const id = SELF_ID;
    process.env.HOSTNAME = SELF_HOST;
    const s = await sandboxes({ self: { id, mounts: [] } });
    const st = await s.status();
    expect(st.available).toBe(false);
    expect(st.reason).toContain("mount the gm-tools volume");
    expect(s.toolsMount()).toBeUndefined();
  });

  it.skipIf(!built)(
    "in Docker, mounts the gm-tools volume by name",
    async () => {
      const id = SELF_ID;
      process.env.HOSTNAME = SELF_HOST;
      const tools = path.join(dir, "tools");
      const s = await sandboxes(
        { self: { id, mounts: [{ Type: "volume", Name: "gm-tools", Source: "/var/lib/docker/volumes/gm-tools/_data", Destination: tools, RW: true }] } },
        { sandboxToolsDir: tools },
      );
      expect((await s.status()).available).toBe(true);
      expect(s.toolsMount()).toEqual({ Type: "volume", Source: "gm-tools", Target: "/opt/gm-tools", ReadOnly: true });
      expect(existsSync(path.join(tools, "bin", "graph-execution"))).toBe(true);
    },
    60_000,
  );
});
