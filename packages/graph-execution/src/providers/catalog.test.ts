import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_PROVIDER_IDS, PROVIDER_CATALOG, PROVIDER_IDS, SANDBOX_CLI_PACKAGES, loginEnvKeys, providerInfo } from "./catalog.js";
import { getProvider } from "./index.js";

describe("provider catalog", () => {
  it("has unique ids, in the documented order", () => {
    expect(PROVIDER_IDS).toEqual(["claude", "codex", "opencode", "qwen", "pi", "omp", "copilot"]);
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
    expect(ENGINE_PROVIDER_IDS).toEqual(["claude", "codex", "opencode", "qwen", "pi", "omp", "copilot"]);
  });

  it("looks entries up by id", () => {
    expect(providerInfo("omp")?.label).toBe("oh-my-pi");
    expect(providerInfo("nope")).toBeUndefined();
  });

  it("lists every CLI package then bun for the sandbox image", () => {
    expect(SANDBOX_CLI_PACKAGES).toEqual([...PROVIDER_CATALOG.map((p) => p.npmPackage), "bun"]);
  });

  it("deduplicates the login env keys", () => {
    const keys = loginEnvKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN"]));
  });

  it("matches session env vars but not login tokens", () => {
    const isSession = (k: string): boolean => PROVIDER_CATALOG.some((p) => p.sessionEnv.test(k));
    for (const k of ["PI_CODING_AGENT", "OMPCODE", "COPILOT_CLI", "CLAUDECODE"]) expect(isSession(k), k).toBe(true);
    for (const k of ["COPILOT_GITHUB_TOKEN", "COPILOT_HOME", "PATH"]) expect(isSession(k), k).toBe(false);
  });

  describe("engine entries have an adapter", () => {
    let dir: string;
    let savedPath: string | undefined;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "ge-catalog-"));
      savedPath = process.env.PATH;
      process.env.PATH = dir;
    });
    afterEach(async () => {
      process.env.PATH = savedPath;
      await rm(dir, { recursive: true, force: true });
    });

    it.each(PROVIDER_CATALOG.filter((p) => p.engine).map((p) => p.id))("getProvider(%s) checks the PATH", async (id) => {
      await expect(getProvider(id, dir)).rejects.toThrow(/not found on the PATH/);
    });

    it("rejects entries without an adapter as not implemented", async () => {
      for (const p of PROVIDER_CATALOG.filter((e) => !e.engine)) {
        await expect(getProvider(p.id, dir)).rejects.toThrow(/is not implemented yet/);
      }
    });
  });
});
