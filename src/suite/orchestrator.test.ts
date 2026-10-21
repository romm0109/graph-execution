import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { isAlive } from "../state/state.js";
import { SuiteControl } from "./control.js";
import { resumeSuite, runSuite } from "./orchestrator.js";
import { defaultSpawn, type SpawnFeature } from "./spawn.js";
import { suiteStateSchema } from "./state.js";

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

// Real children run the built CLI; vitest.global-setup.ts builds dist/ before the suite.
const root = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(root, "dist", "cli.js");
const fixtures = path.join(root, "src", "__fixtures__");

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await tempRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Copies the diamond fixture and the spec into `<repo>/<name>` and `<repo>/PRD-<name>.md`. */
async function addFeature(repo: string, name: string): Promise<{ tasksDir: string; prd: string }> {
  await cp(path.join(fixtures, "diamond"), path.join(repo, name), { recursive: true });
  await cp(path.join(fixtures, "spec.md"), path.join(repo, `PRD-${name}.md`));
  return { tasksDir: path.join(repo, name), prd: path.join(repo, `PRD-${name}.md`) };
}

async function addTasks(repo: string, name: string, ids: string[]): Promise<{ tasksDir: string; prd: string }> {
  await mkdir(path.join(repo, name), { recursive: true });
  for (const id of ids) {
    await writeFile(
      path.join(repo, name, `${id}.json`),
      JSON.stringify({ id, content: `Do ${id}.`, dependencies: [], validate: null }),
    );
  }
  await cp(path.join(fixtures, "spec.md"), path.join(repo, `PRD-${name}.md`));
  return { tasksDir: path.join(repo, name), prd: path.join(repo, `PRD-${name}.md`) };
}

const commitAll = async (repo: string): Promise<void> => {
  await gitOut(repo, ["add", "-A"]);
  await gitOut(repo, ["commit", "-q", "-m", "features"]);
};

const suiteDirIn = async (repo: string): Promise<string> => {
  const { readdir } = await import("node:fs/promises");
  const name = (await readdir(path.join(repo, ".graph-execution"))).find((n) => n.startsWith("suite-"));
  expect(name).toBeDefined();
  return path.join(repo, ".graph-execution", name!);
};

const loadSuite = async (repo: string) =>
  suiteStateSchema.parse(JSON.parse(await readFile(path.join(await suiteDirIn(repo), "suite.json"), "utf8")));

describe("runSuite", () => {
  it("runs two features as child runs without applying anything", () =>
    withRepo(async (repo) => {
      const features = [await addFeature(repo, "auth"), await addFeature(repo, "export")];
      await commitAll(repo);
      const code = await runSuite({ cwd: repo, features, provider: "fake", concurrency: 4, merge: false, cliPath, log: () => {} });
      expect(code).toBe(0);
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("done");
      const dir = await suiteDirIn(repo);
      for (const f of suite.features) {
        expect(f.status).toBe("done");
        expect(f.share).toBe(2);
        expect(f.finishedAt).toBeDefined();
        const state = JSON.parse(await readFile(path.join(dir, "features", f.runId, "state.json"), "utf8"));
        expect(state.status).toBe("done");
        expect(await gitOut(repo, ["rev-parse", "--verify", `graph/${f.runId}`])).toMatch(/^[0-9a-f]{40}$/);
      }
      expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    }), 60_000);

  it("queues features beyond the cap with share 1", () =>
    withRepo(async (repo) => {
      const features = [await addFeature(repo, "a"), await addFeature(repo, "b"), await addFeature(repo, "c")];
      await commitAll(repo);
      const base = defaultSpawn(cliPath, repo);
      const started: { at: number; share: string }[] = [];
      const exitedAt: number[] = [];
      const spawn: SpawnFeature = (args, env, logFile) => {
        started.push({ at: Date.now(), share: args[args.indexOf("--concurrency") + 1]! });
        const proc = base(args, env, logFile);
        return { ...proc, exited: proc.exited.then((c) => (exitedAt.push(Date.now()), c)) };
      };
      const code = await runSuite({ cwd: repo, features, provider: "fake", concurrency: 2, merge: false, spawn, log: () => {} });
      expect(code).toBe(0);
      expect(started.map((s) => s.share)).toEqual(["1", "1", "1"]);
      expect(started[2]!.at).toBeGreaterThanOrEqual(Math.min(...exitedAt));
    }), 90_000);

  it("keeps going when one feature fails", () =>
    withRepo(async (repo) => {
      const bad = await addTasks(repo, "bad", ["1"]);
      const good = await addTasks(repo, "good", ["g1", "g2"]);
      await commitAll(repo);
      const script = path.join(repo, ".git", "fake-script.json");
      const fail = { commit: false, write: {} };
      await writeFile(script, JSON.stringify({ "task:1": { attempts: [fail, fail, fail] } }));
      process.env.GRAPH_EXECUTION_FAKE_SCRIPT = script;
      const lines: string[] = [];
      try {
        const code = await runSuite({
          cwd: repo,
          features: [bad, good],
          provider: "fake",
          concurrency: 2,
          merge: false,
          cliPath,
          log: (l) => lines.push(l),
        });
        expect(code).toBe(2);
      } finally {
        delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
      }
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("failed");
      expect(Object.fromEntries(suite.features.map((f) => [f.name, f.status]))).toEqual({ bad: "failed", good: "done" });
      expect(lines.join("\n")).toContain("failed features: bad");
    }), 60_000);

  it("stops every child on abort", () =>
    withRepo(async (repo) => {
      const features = [await addFeature(repo, "a"), await addFeature(repo, "b")];
      await commitAll(repo);
      const script = path.join(repo, ".git", "fake-script.json");
      await writeFile(script, JSON.stringify({ "task:1": { attempts: [{ hang: true }] } }));
      process.env.GRAPH_EXECUTION_FAKE_SCRIPT = script;
      const ctl = new AbortController();
      const base = defaultSpawn(cliPath, repo);
      let count = 0;
      const spawn: SpawnFeature = (...args) => {
        const proc = base(...args);
        if (++count === 2) setTimeout(() => ctl.abort(), 3000);
        return proc;
      };
      try {
        const code = await runSuite({ cwd: repo, features, provider: "fake", concurrency: 2, merge: false, spawn, signal: ctl.signal, log: () => {} });
        expect(code).toBe(2);
      } finally {
        delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
      }
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("aborted");
      for (const f of suite.features) {
        expect(f.status).toBe("stopped");
        expect(isAlive(f.pid!)).toBe(false);
      }
    }), 60_000);

  it("rejects fewer than 2 features before creating anything", () =>
    withRepo(async (repo) => {
      const f = await addFeature(repo, "a");
      await expect(runSuite({ cwd: repo, features: [f], provider: "fake", merge: false, cliPath })).rejects.toThrow(/at least 2/);
      await expect(
        runSuite({ cwd: repo, features: [f, { ...f, prd: path.join(repo, "missing.md") }], provider: "fake", merge: false, cliPath }),
      ).rejects.toThrow();
    }));
});

async function until(cond: () => boolean, ms = 40_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const failTwice = { commit: false, write: {} };
const failScript = { "task:1": { attempts: [failTwice, failTwice, failTwice] } };

/** Spawn that records the args of every start. */
function recordingSpawn(repo: string, starts: string[][]): SpawnFeature {
  const base = defaultSpawn(cliPath, repo);
  return (args, env, logFile) => {
    starts.push(args);
    return base(args, env, logFile);
  };
}

async function withScript(repo: string, script: unknown, fn: (file: string) => Promise<void>): Promise<void> {
  const file = path.join(repo, ".git", "fake-script.json");
  await writeFile(file, JSON.stringify(script));
  process.env.GRAPH_EXECUTION_FAKE_SCRIPT = file;
  try {
    await fn(file);
  } finally {
    delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
  }
}

describe("resumeSuite and SuiteControl", () => {
  it("resumes a failed feature and ends done", () =>
    withRepo(async (repo) => {
      const bad = await addTasks(repo, "bad", ["1"]);
      const good = await addTasks(repo, "good", ["g1", "g2"]);
      await commitAll(repo);
      await withScript(repo, failScript, async (file) => {
        const code = await runSuite({ cwd: repo, features: [bad, good], provider: "fake", concurrency: 2, merge: false, cliPath, log: () => {} });
        expect(code).toBe(2);
        await writeFile(file, "{}");
        const starts: string[][] = [];
        const lines: string[] = [];
        const code2 = await resumeSuite({ cwd: repo, spawn: recordingSpawn(repo, starts), log: (l) => lines.push(l) });
        expect(code2).toBe(0);
        const suite = await loadSuite(repo);
        expect(suite.status).toBe("done");
        expect(suite.features.map((f) => f.status)).toEqual(["done", "done"]);
        const badRun = suite.features.find((f) => f.name === "bad")!.runId;
        expect(starts).toEqual([["--resume", "--run", badRun]]);
      });
    }), 120_000);

  it("refuses to resume a finished suite", () =>
    withRepo(async (repo) => {
      const features = [await addFeature(repo, "a"), await addFeature(repo, "b")];
      await commitAll(repo);
      expect(await runSuite({ cwd: repo, features, provider: "fake", concurrency: 2, merge: false, cliPath, log: () => {} })).toBe(0);
      await expect(resumeSuite({ cwd: repo, log: () => {} })).rejects.toThrow(/already finished/);
      await expect(resumeSuite({ cwd: repo, suiteId: "suite-nope", log: () => {} })).rejects.toThrow(/no suite suite-nope to resume/);
    }), 60_000);

  it("retries a failed feature while another still runs", () =>
    withRepo(async (repo) => {
      const bad = await addTasks(repo, "bad", ["1"]);
      const good = await addTasks(repo, "good", ["g1"]);
      await commitAll(repo);
      await withScript(repo, { ...failScript, "task:g1": { attempts: [{ hang: true }] } }, async (file) => {
        const control = new SuiteControl();
        const ctl = new AbortController();
        const starts: string[][] = [];
        const done = runSuite({
          cwd: repo,
          features: [bad, good],
          provider: "fake",
          concurrency: 2,
          merge: false,
          spawn: recordingSpawn(repo, starts),
          control,
          signal: ctl.signal,
          log: () => {},
        });
        await until(() => control.allowed.retry.includes("bad"));
        expect(control.retryFeature("good")).toEqual({ ok: false, reason: "not_failed" });
        expect(control.startIntegration().ok).toBe(false);
        await writeFile(file, JSON.stringify({ "task:g1": { attempts: [{ hang: true }] } }));
        expect(control.retryFeature("bad")).toEqual({ ok: true });
        await until(() => starts.some((a) => a[0] === "--resume"));
        expect(starts.at(-1)![0]).toBe("--resume");
        ctl.abort();
        expect(await done).toBe(2);
        expect((await loadSuite(repo)).status).toBe("aborted");
      });
    }), 120_000);

  it("excludes failed features when integration starts", () =>
    withRepo(async (repo) => {
      const bad = await addTasks(repo, "bad", ["1"]);
      const good = await addTasks(repo, "good", ["g1"]);
      await commitAll(repo);
      await withScript(repo, failScript, async () => {
        const control = new SuiteControl();
        const lines: string[] = [];
        const done = runSuite({ cwd: repo, features: [bad, good], provider: "fake", concurrency: 2, merge: false, cliPath, control, log: (l) => lines.push(l) });
        await until(() => control.allowed.integrate);
        expect(control.startIntegration()).toEqual({ ok: true });
        expect(await done).toBe(0);
        const suite = await loadSuite(repo);
        expect(suite.status).toBe("done");
        expect(Object.fromEntries(suite.features.map((f) => [f.name, f.status]))).toEqual({ bad: "excluded", good: "done" });
        expect(lines.join("\n")).toContain("excluded: bad");
      });
    }), 120_000);

  it("tells to --resume when there is no control", () =>
    withRepo(async (repo) => {
      const bad = await addTasks(repo, "bad", ["1"]);
      const good = await addTasks(repo, "good", ["g1"]);
      await commitAll(repo);
      await withScript(repo, failScript, async () => {
        const lines: string[] = [];
        expect(await runSuite({ cwd: repo, features: [bad, good], provider: "fake", concurrency: 2, merge: false, cliPath, log: (l) => lines.push(l) })).toBe(2);
        expect(lines.join("\n")).toContain("run graph-execution suite --resume to retry the failed features");
      });
    }), 60_000);
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
        expect(failed.integration).toEqual({ merged: ["a"], failed: "b" });
        expect(lines.join("\n")).toContain("run graph-execution suite --resume to retry the integration");
        await writeFile(file, JSON.stringify({ "resolver:integration-b": { attempts: [{ write: { "shared.txt": "resolved\n" } }] } }));
        const starts: string[][] = [];
        expect(await resumeSuite({ cwd: repo, spawn: recordingSpawn(repo, starts), log: () => {} })).toBe(0);
        expect(starts).toEqual([]);
      });
      const suite = await loadSuite(repo);
      expect(suite.status).toBe("done");
      expect(suite.integration).toEqual({ merged: ["a", "b"] });
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
