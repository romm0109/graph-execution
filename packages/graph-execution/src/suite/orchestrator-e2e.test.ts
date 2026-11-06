import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { SuiteControl } from "./control.js";
import { resumeSuite, runSuite } from "./orchestrator.js";
import { defaultSpawn, type SpawnFeature } from "./spawn.js";
import { cliPath, withRepo, addTasks, commitAll, suiteDirIn, loadSuite, until, failScript, recordingSpawn, withScript } from "../__fixtures__/suite.js";

// The e2e phase runs in this process: the providers it gets are wrapped to record every prompt.
const prompts = vi.hoisted(() => [] as { key: string; prompt: string }[]);
vi.mock("../providers/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../providers/index.js")>();
  return {
    ...mod,
    getProvider: async (...args: Parameters<typeof mod.getProvider>) => {
      const provider = await mod.getProvider(...args);
      return {
        ...provider,
        run: (opts: Parameters<typeof provider.run>[0]) => {
          prompts.push({ key: `${opts.role}:${opts.label}`, prompt: opts.prompt });
          return provider.run(opts);
        },
      };
    },
  };
});

describe("suite integration", () => {
  const rid = (suite: { suiteId: string }): string => suite.suiteId.slice("suite-".length);

  it("merges every feature into suite/<rid> in finish order without a resolver", () =>
    withRepo(async (repo) => {
      const a = await addTasks(repo, "a", ["a1"]);
      const b = await addTasks(repo, "b", ["b1"]);
      await commitAll(repo);
      const log = path.join(repo, ".git", "fake.log");
      process.env.GRAPH_EXECUTION_FAKE_LOG = log;
      try {
        expect(await runSuite({ cwd: repo, features: [a, b], provider: "fake", concurrency: 2, merge: false, cliPath, log: () => {} })).toBe(0);
      } finally {
        delete process.env.GRAPH_EXECUTION_FAKE_LOG;
      }
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("done");
      const branch = `suite/${rid(suite)}`;
      expect(suite.integrationBranch).toBe(branch);
      const order = [...suite.features].sort((x, y) => x.finishedAt!.localeCompare(y.finishedAt!)).map((f) => f.name);
      expect(suite.integration.merged).toEqual(order);
      const merges = (await gitOut(repo, ["log", "--first-parent", "--merges", "--format=%s", branch])).split("\n").reverse();
      expect(merges).toEqual(order.map((n) => `Merge feature ${n}`));
      expect(await readFile(log, "utf8")).not.toContain("resolver:");
    }), 90_000);

  async function conflicting(repo: string): Promise<{ features: { tasksDir: string; prd: string }[]; script: Record<string, unknown> }> {
    const a = await addTasks(repo, "a", ["a1"]);
    const b = await addTasks(repo, "b", ["b1"]);
    await commitAll(repo);
    return {
      features: [a, b],
      script: {
        "task:a1": { attempts: [{ write: { "shared.txt": "from a\n" } }] },
        "task:b1": { attempts: [{ write: { "shared.txt": "from b\n" } }] },
      },
    };
  }

  it("calls the integration agent on a conflict", () =>
    withRepo(async (repo) => {
      const { features, script } = await conflicting(repo);
      // Run b after a so the conflicting merge (and its label) is deterministic.
      await withScript(repo, { ...script, "resolver:integration-b": { attempts: [{ write: { "shared.txt": "resolved\n" } }] } }, async () => {
        expect(await runSuite({ cwd: repo, features, provider: "fake", concurrency: 1, merge: false, cliPath, log: () => {} })).toBe(0);
      });
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("done");
      expect(await gitOut(repo, ["show", `suite/${rid(suite)}:shared.txt`])).toBe("resolved");
      // The agent is recorded for the page's node, and its output kept in the suite's logs (PRD §6).
      expect(suite.integration.agents).toEqual({ b: { files: ["shared.txt"], attempt: 1, attempts: 3, status: "resolved" } });
      expect(await readFile(path.join(repo, ".graph-execution", suite.suiteId, "logs", "integration-b.log"), "utf8")).toContain("wrote shared.txt");
    }), 120_000);

  it("fails with integration.failed when the agent gives up, and --resume retries only that merge", () =>
    withRepo(async (repo) => {
      const { features, script } = await conflicting(repo);
      const bad = { exitCode: 1, commit: false, write: {} };
      const lines: string[] = [];
      await withScript(repo, { ...script, "resolver:integration-b": { attempts: [bad, bad, bad] } }, async (file) => {
        expect(await runSuite({ cwd: repo, features, provider: "fake", concurrency: 1, merge: false, cliPath, log: (l) => lines.push(l) })).toBe(2);
        const failed = await loadSuite(repo);
        expect(failed.status).toBe("failed");
        expect(failed.integration).toEqual({ merged: ["a"], failed: "b", agents: { b: { files: ["shared.txt"], attempt: 3, attempts: 3, status: "failed" } } });
        expect(lines.join("\n")).toContain("run graph-execution suite --resume to retry the integration");
        await writeFile(file, JSON.stringify({ "resolver:integration-b": { attempts: [{ write: { "shared.txt": "resolved\n" } }] } }));
        const starts: string[][] = [];
        expect(await resumeSuite({ cwd: repo, spawn: recordingSpawn(repo, starts), log: () => {} })).toBe(0);
        expect(starts).toEqual([]);
      });
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("done");
      expect(suite.integration).toEqual({ merged: ["a", "b"], agents: { b: { files: ["shared.txt"], attempt: 1, attempts: 3, status: "resolved" } } });
      expect(await gitOut(repo, ["show", `suite/${rid(suite)}:shared.txt`])).toBe("resolved");
      expect(await gitOut(repo, ["log", "--first-parent", "--merges", "--format=%s", `suite/${rid(suite)}`])).toBe("fake: resolver:integration-b attempt 1\nMerge feature a");
    }), 120_000);

  it("does not merge an excluded feature", () =>
    withRepo(async (repo) => {
      const bad = await addTasks(repo, "bad", ["1"]);
      const good = await addTasks(repo, "good", ["g1"]);
      await commitAll(repo);
      await withScript(repo, failScript, async () => {
        const control = new SuiteControl();
        const done = runSuite({ cwd: repo, features: [bad, good], provider: "fake", concurrency: 2, merge: false, cliPath, control, log: () => {} });
        await until(() => control.allowed.integrate);
        control.startIntegration();
        expect(await done).toBe(0);
      });
      const suite = await loadSuite(repo);
      expect(suite.integration.merged).toEqual(["good"]);
      expect(await gitOut(repo, ["log", "--first-parent", "--merges", "--format=%s", `suite/${rid(suite)}`])).toBe("Merge feature good");
    }), 120_000);
});

describe("suite e2e phase and apply", () => {
  const planOf = JSON.stringify({ cases: [{ id: "P1", title: "works", steps: ["run it"], expected: "ok", priority: "must" }] });

  async function twoFeatures(repo: string, opts: { overlap: boolean }) {
    const a = await addTasks(repo, "auth", ["a1"]);
    const b = await addTasks(repo, "export", ["b1"]);
    for (const f of [a, b]) await writeFile(path.join(f.tasksDir, "test-plan.json"), planOf);
    await commitAll(repo);
    const script: Record<string, unknown> = {
      ...featureTester,
      "task:a1": { attempts: [{ write: opts.overlap ? { "shared.txt": "from a\n", "a.txt": "a\n" } : { "a.txt": "a\n" } }] },
      "task:b1": { attempts: [{ write: opts.overlap ? { "shared.txt": "from b\n", "b.txt": "b\n" } : { "b.txt": "b\n" } }] },
    };
    if (opts.overlap) script["resolver:integration-export"] = { attempts: [{ write: { "shared.txt": "resolved\n" } }] };
    return { features: [a, b], script };
  }
  const pass = (id: string) => ({ id, verdict: "pass", evidence: "ok" });
  const featureTester = { "tester:tester-r0": { attempts: [{ report: { cases: [pass("P1")] } }] } };
  const suiteTester = { "tester:tester-r0": { attempts: [{ report: { cases: [pass("auth-P1"), pass("export-P1")] } }] } };
  /** Runs the features with `script`, then swaps in `suiteScript` (read again by the in-process e2e phase). */
  const run = (repo: string, features: { tasksDir: string; prd: string }[], merge = true, suiteScript: object = {}) => {
    const file = path.join(repo, ".git", "fake-script.json");
    const base = defaultSpawn(cliPath, repo);
    let exits = 0;
    const spawn: SpawnFeature = (...args) => {
      const proc = base(...args);
      return {
        ...proc,
        exited: proc.exited.then(async (code) => {
          if (++exits === features.length) await writeFile(file, JSON.stringify(suiteScript));
          return code;
        }),
      };
    };
    return runSuite({ cwd: repo, features, provider: "fake", concurrency: 1, merge, spawn, log: () => {} });
  };
  const suiteExtra = { "resolver:integration-export": { attempts: [{ write: { "shared.txt": "resolved\n" } }] } };
  const keys = (): string[] => prompts.map((p) => p.key);

  it("reviews the overlap files with all PRDs, tests with prefixed plans, and applies", () =>
    withRepo(async (repo) => {
      const { features, script } = await twoFeatures(repo, { overlap: true });
      prompts.length = 0;
      await withScript(repo, script, async () => {
        expect(await run(repo, features, true, { ...suiteTester, ...suiteExtra })).toBe(0);
      });
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("applied");
      expect(suite.applied!.files).toBeGreaterThan(0);
      const reviewer = prompts.find((p) => p.key === "reviewer:code-r0")!;
      expect(reviewer.prompt).toContain("shared.txt");
      expect(reviewer.prompt).not.toContain("a.txt");
      expect(reviewer.prompt).not.toContain("b.txt");
      const tester = prompts.find((p) => p.key === "tester:tester-r0")!;
      expect(tester.prompt).toContain("auth-P1");
      expect(tester.prompt).toContain("export-P1");
      const status = await gitOut(repo, ["status", "--porcelain"]);
      for (const f of ["shared.txt", "a.txt", "b.txt"]) expect(status).toContain(f);
      expect(await readFile(path.join(repo, "shared.txt"), "utf8")).toBe("resolved\n");
    }), 180_000);

  it("records the code review as not needed when no file overlaps", () =>
    withRepo(async (repo) => {
      const { features, script } = await twoFeatures(repo, { overlap: false });
      prompts.length = 0;
      await withScript(repo, script, async () => {
        expect(await run(repo, features, true, { ...suiteTester, ...suiteExtra })).toBe(0);
      });
      const dir = await suiteDirIn(repo);
      const code = JSON.parse(await readFile(path.join(dir, "reports", "round0", "code.json"), "utf8"));
      expect(code.notes.join(" ")).toContain("code review not needed");
      expect(keys().some((k) => k.startsWith("reviewer:"))).toBe(false);
      expect(keys()).toContain("tester:tester-r0");
      expect((await loadSuite(repo)).status).toBe("applied");
    }), 180_000);

  it("runs only the validation with e2eReview false", () =>
    withRepo(async (repo) => {
      const { features, script } = await twoFeatures(repo, { overlap: false });
      await writeFile(path.join(repo, "graph-execution.config.json"), JSON.stringify({ e2eReview: false }));
      await commitAll(repo);
      prompts.length = 0;
      await withScript(repo, script, async () => {
        expect(await run(repo, features, true, { ...suiteTester, ...suiteExtra })).toBe(0);
      });
      expect(keys().some((k) => k.startsWith("reviewer:") || k.startsWith("tester:"))).toBe(false);
      expect((await loadSuite(repo)).status).toBe("applied");
    }), 180_000);

  it("does not apply with merge false", () =>
    withRepo(async (repo) => {
      const { features, script } = await twoFeatures(repo, { overlap: false });
      await withScript(repo, script, async () => {
        expect(await run(repo, features, false, suiteTester)).toBe(0);
      });
      expect((await loadSuite(repo)).status).toBe("done");
      expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    }), 180_000);

  it("ends failed with a blocker in every round", () =>
    withRepo(async (repo) => {
      const { features, script } = await twoFeatures(repo, { overlap: false });
      await writeFile(path.join(repo, "graph-execution.config.json"), JSON.stringify({ fixPasses: 1 }));
      await commitAll(repo);
      const failing = { attempts: [{ report: { cases: [{ id: "auth-P1", verdict: "fail", evidence: "broken" }, pass("export-P1")] } }] };
      const reports = { "tester:tester-r0": failing, "tester:tester-r1": failing };
      await withScript(repo, script, async () => {
        expect(await run(repo, features, true, reports)).toBe(1);
      });
      expect((await loadSuite(repo)).status).toBe("failed");
      expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    }), 180_000);
});
