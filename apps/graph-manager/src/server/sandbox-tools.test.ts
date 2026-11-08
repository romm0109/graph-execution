import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import { defaultGraphExecutionBin } from "./config.js";
import { Sandboxes } from "./sandbox.js";
import { copyProviderClis, engineDirOf, fillTools } from "./sandbox-tools.js";
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
      expect(await fillTools(tools, { engineDir: engineDir as string, gmVersion: "t", pathEnv: "" })).toBe("filled");
      const wrapper = path.join(tools, "bin", "graph-execution");
      const version = await engineVersion();
      const out = await execa(wrapper, ["--version"], { env: { PATH: process.env.PATH }, extendEnv: false });
      expect(out.stdout.trim()).toContain(version);
      expect(existsSync(path.join(tools, "graph-execution", "node_modules", "zod", "package.json"))).toBe(true);
      expect(existsSync(path.join(tools, "graph-execution", "node_modules", "commander", "package.json"))).toBe(true);
      expect(existsSync(path.join(tools, "VERSION"))).toBe(true);
      expect((await readdir(tools)).filter((e) => e.startsWith(".next-"))).toEqual([]);

      // Self-contained: runs from a cwd outside the repo.
      const outside = await execa("node", [path.join(tools, "graph-execution", "dist", "cli.js"), "--version"], { cwd: os.tmpdir() });
      expect(outside.stdout.trim()).toContain(version);

      const mtime = statSync(wrapper).mtimeMs;
      expect(await fillTools(tools, { engineDir: engineDir as string, gmVersion: "t", pathEnv: "" })).toBe("fresh");
      expect(statSync(wrapper).mtimeMs).toBe(mtime);
    },
    60_000,
  );
});

describe("copyProviderClis", () => {
  it("copies an npm package CLI and a single-file CLI with working wrappers", async () => {
    const pkg = path.join(dir, "pkgs", "node_modules", "@x", "claude");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@x/claude", bin: { claude: "cli.js" }, dependencies: { dep: "1" } }));
    await writeFile(path.join(pkg, "cli.js"), "#!/usr/bin/env node\nimport('dep').then(() => console.log('claude-ok'));\n");
    await chmod(path.join(pkg, "cli.js"), 0o755);
    const dep = path.join(dir, "pkgs", "node_modules", "dep");
    await mkdir(dep, { recursive: true });
    await writeFile(path.join(dep, "package.json"), JSON.stringify({ name: "dep", main: "index.js" }));
    await writeFile(path.join(dep, "index.js"), "module.exports = 1;\n");

    const fakebin = path.join(dir, "fakebin");
    await mkdir(fakebin);
    await symlink(path.join(pkg, "cli.js"), path.join(fakebin, "claude"));
    await writeFile(path.join(fakebin, "codex"), "#!/bin/sh\necho codex-ok\n", { mode: 0o755 });
    await chmod(path.join(fakebin, "codex"), 0o755);

    const dest = path.join(dir, "dest");
    expect(await copyProviderClis(dest, fakebin)).toEqual(["claude", "codex"]);
    expect(existsSync(path.join(dest, "lib", "claude", "node_modules", "dep", "package.json"))).toBe(true);
    const env = { PATH: process.env.PATH };
    expect((await execa(path.join(dest, "bin", "claude"), [], { env, extendEnv: false, cwd: os.tmpdir() })).stdout.trim()).toBe("claude-ok");
    expect((await execa(path.join(dest, "bin", "codex"), [], { env, extendEnv: false })).stdout.trim()).toBe("codex-ok");
    expect(existsSync(path.join(dest, "lib", "codex", "codex"))).toBe(true);
  });

  it("copies nothing from an empty PATH", async () => {
    expect(await copyProviderClis(path.join(dir, "dest"), "")).toEqual([]);
  });
});

describe("Sandboxes tools", () => {
  let savedHost: string | undefined;
  beforeEach(() => {
    savedHost = process.env.HOSTNAME;
  });
  afterEach(() => {
    if (savedHost === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = savedHost;
  });

  async function sandboxes(fakeOpts: Parameters<typeof startFakeDocker>[0], overrides: Parameters<typeof testConfig>[1] = {}): Promise<Sandboxes> {
    const f = await startFakeDocker(fakeOpts);
    fakes.push(f);
    const config = testConfig(dir, { dockerSocket: f.socketPath, graphExecutionBin: BIN, ...overrides });
    const store = await DataStore.open(config.dataDir);
    return new Sandboxes({ config, store, pathEnv: "" });
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
