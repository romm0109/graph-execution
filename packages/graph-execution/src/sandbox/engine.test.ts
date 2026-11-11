import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheDir, ensureEngineCopy, runningEngineDir } from "./engine.js";

let cache: string;
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "graph-execution-cache-"));
});
afterAll(async () => {
  await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("engine copy", () => {
  it("picks the cache dir from the environment", () => {
    expect(cacheDir({ GRAPH_EXECUTION_CACHE_DIR: "/x/y" })).toBe(path.resolve("/x/y"));
    expect(cacheDir({ XDG_CACHE_HOME: "/c" })).toBe(path.join(path.resolve("/c"), "graph-execution"));
  });

  it("copies the running engine with its dependencies once per version", async () => {
    // vitest.global-setup.ts builds dist/ first.
    const dir = await ensureEngineCopy({ cacheDir: cache });
    expect(path.dirname(dir)).toBe(path.join(cache, "sandbox-engine"));
    for (const f of ["dist/cli.js", "node_modules/zod/package.json", "sandbox/Dockerfile.template", "package.json", "VERSION"]) {
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    }
    const mtime = statSync(path.join(dir, "VERSION")).mtimeMs;
    expect(await ensureEngineCopy({ cacheDir: cache, engineDir: runningEngineDir() })).toBe(dir);
    expect(statSync(path.join(dir, "VERSION")).mtimeMs).toBe(mtime);

    const res = await execa("node", [path.join(dir, "dist", "cli.js"), "--version"], { cwd: cache, reject: false });
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
