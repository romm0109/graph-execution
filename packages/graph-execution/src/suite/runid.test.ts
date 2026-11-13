import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../launch/preflight.js";
import { RUN_ID_ENV, SANDBOX_ENV, SANDBOX_IMAGE_ENV } from "../state/paths.js";
import { addFeature, commitAll, withRepo } from "../__fixtures__/suite.js";
import { newSuiteId, runSuite } from "./orchestrator.js";
import type { SpawnFeature } from "./spawn.js";
import { suiteStateSchema } from "./state.js";

// Every feature fails at once: the test only looks at the suite folder and its suite.json.
const failing: SpawnFeature = () => ({ pid: 0, exited: Promise.resolve(1), stop: () => {} });

async function start(repo: string, env: NodeJS.ProcessEnv) {
  const features = [await addFeature(repo, "auth"), await addFeature(repo, "export")];
  await commitAll(repo);
  return runSuite({ cwd: repo, features, provider: "fake", merge: false, spawn: failing, env, log: () => {} });
}

describe("newSuiteId", () => {
  it("takes GRAPH_EXECUTION_RUN_ID only when it is a suite id", () => {
    expect(newSuiteId({ [RUN_ID_ENV]: "suite-gm-x" })).toBe("suite-gm-x");
    expect(newSuiteId({ [RUN_ID_ENV]: "gm-x" })).toMatch(/^suite-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(newSuiteId({ [RUN_ID_ENV]: "suite-../x" })).not.toBe("suite-../x");
    expect(newSuiteId({})).toMatch(/^suite-/);
  });
});

describe("a suite started with a forced id", () => {
  it("uses GRAPH_EXECUTION_RUN_ID=suite-… as its folder and records the sandbox image", () =>
    withRepo(async (repo) => {
      // graph-manager creates the folder (reviewers copy, ready file) before the container starts.
      const dir = path.join(repo, ".graph-execution", "suite-gm-x");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, ".sandbox-reviewers.json"), "[]");
      await start(repo, { [RUN_ID_ENV]: "suite-gm-x", [SANDBOX_ENV]: "1", [SANDBOX_IMAGE_ENV]: "img:1" });
      const suite = suiteStateSchema.parse(JSON.parse(await readFile(path.join(dir, "suite.json"), "utf8")));
      expect(suite.suiteId).toBe("suite-gm-x");
      expect(suite.sandbox).toEqual({ image: "img:1" });
    }), 30_000);

  it("ignores an id without the suite- prefix and records no sandbox outside one", () =>
    withRepo(async (repo) => {
      await start(repo, { [RUN_ID_ENV]: "gm-x" });
      expect(existsSync(path.join(repo, ".graph-execution", "gm-x"))).toBe(false);
      const { readdir } = await import("node:fs/promises");
      const [id] = (await readdir(path.join(repo, ".graph-execution"))).filter((n) => n.startsWith("suite-"));
      const suite = suiteStateSchema.parse(JSON.parse(await readFile(path.join(repo, ".graph-execution", id!, "suite.json"), "utf8")));
      expect(suite.suiteId).toBe(id);
      expect(suite.sandbox).toBeUndefined();
    }), 30_000);

  it("refuses an id whose suite already exists", () =>
    withRepo(async (repo) => {
      const dir = path.join(repo, ".graph-execution", "suite-gm-x");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "suite.json"), "{}");
      const err = await start(repo, { [RUN_ID_ENV]: "suite-gm-x" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toBe("suite suite-gm-x already exists");
    }), 30_000);
});
