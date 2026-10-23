import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addFeature, cliPath, commitAll, loadSuite, suiteDirIn, withRepo, withRepos } from "../__fixtures__/suite.js";
import { runSuite, validateSuite } from "./orchestrator.js";
import type { FeatureProcess, SpawnFeature } from "./spawn.js";
import { SuiteStore } from "./state.js";

describe("multi-repo suites", () => {
  it("records both repos in suite.json when launched from a non-repo folder", () =>
    withRepos(2, async ([a, b], folder) => {
      const features = [await addFeature(a!, "auth"), await addFeature(b!, "export")];
      await commitAll(a!);
      await commitAll(b!);
      const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
      const spawn: SpawnFeature = (args, env) => {
        calls.push({ args, env });
        const proc: FeatureProcess = { pid: 1, exited: Promise.resolve(1), stop() {} };
        return proc;
      };
      await runSuite({ cwd: folder, features, provider: "fake", concurrency: 2, merge: false, spawn, log: () => {} });
      const suite = await loadSuite(folder);
      expect(suite.repos.map((r) => r.root)).toEqual([await realpath(a!), await realpath(b!)]);
      expect(suite.repos.map((r) => r.name)).toHaveLength(2);
      expect(new Set(suite.repos.map((r) => r.name)).size).toBe(2);
      expect(suite.features.map((f) => f.repo)).toEqual(suite.repos.map((r) => r.name));
      expect(suite.startingCommit).toBe(suite.repos[0]!.startingCommit);
      expect(calls).toHaveLength(2);
    }), 60_000);

  it("rejects a tasks folder that is not in a git repo", () =>
    withRepos(1, async ([a], folder) => {
      const good = await addFeature(a!, "auth");
      await mkdir(path.join(folder, "loose"), { recursive: true });
      const bad = { tasksDir: path.join(folder, "loose"), prd: good.prd };
      await expect(validateSuite({ cwd: folder, features: [good, bad], provider: "fake" })).rejects.toThrow("not in a git repo");
    }));

  it("migrates a suite.json without repos", () =>
    withRepo(async (repo) => {
      const dir = path.join(repo, ".graph-execution", "suite-old");
      await mkdir(dir, { recursive: true });
      const feature = (name: string) => ({ name, tasksDir: `/x/${name}`, prd: "/x/p.md", runId: name, status: "done" });
      const file = path.join(dir, "suite.json");
      await writeFile(
        file,
        JSON.stringify({
          suiteId: "suite-old",
          status: "failed",
          provider: "fake",
          concurrency: 2,
          startingCommit: "abc",
          startBranch: "main",
          merge: false,
          features: [feature("a"), feature("b")],
          createdAt: "2020-01-01T00:00:00Z",
        }),
      );
      const { state } = await SuiteStore.load(file);
      expect(state.repos).toEqual([{ name: path.basename(repo).replace(/[^A-Za-z0-9_-]/g, "-"), root: path.resolve(dir, "..", ".."), startingCommit: "abc", startBranch: "main" }]);
      expect(state.features.map((f) => f.repo)).toEqual([state.repos[0]!.name, state.repos[0]!.name]);
      expect(JSON.parse(await readFile(file, "utf8")).repos).toBeUndefined();
    }));

  it("runs features of two repos to done with the real CLI", () =>
    withRepos(2, async ([a, b], folder) => {
      const features = [await addFeature(a!, "auth"), await addFeature(b!, "export")];
      await commitAll(a!);
      await commitAll(b!);
      // Integration is still single-repo, so the suite's own outcome is not asserted.
      await runSuite({ cwd: folder, features, provider: "fake", concurrency: 2, merge: false, cliPath, log: () => {} }).catch(() => {});
      const suite = await loadSuite(folder);
      expect(suite.features.every((f) => f.status === "done")).toBe(true);
      const dir = await suiteDirIn(folder);
      for (const f of suite.features) {
        expect(JSON.parse(await readFile(path.join(dir, "features", f.runId, "state.json"), "utf8")).status).toBe("done");
      }
    }), 90_000);
});
