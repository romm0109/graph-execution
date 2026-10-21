import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { isAlive } from "../state/state.js";
import { SuiteControl } from "./control.js";
import { resumeSuite, runSuite } from "./orchestrator.js";
import { defaultSpawn, type SpawnFeature } from "./spawn.js";
import { cliPath, withRepo, addFeature, addTasks, commitAll, suiteDirIn, loadSuite, until, failScript, recordingSpawn, withScript } from "../__fixtures__/suite.js";

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
