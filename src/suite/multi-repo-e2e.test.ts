import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { addTasks, cliPath, commitAll, loadSuite, suiteDirIn, withRepos, withScript } from "../__fixtures__/suite.js";
import { HumanReviewStore } from "../review/human.js";
import { RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import { runSuite } from "./orchestrator.js";
import { buildSuiteInputs } from "./e2e.js";
import { SuiteStore } from "./state.js";
import { defaultSpawn, type SpawnFeature } from "./spawn.js";

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

async function twoRepos(
  fn: (ctx: { a: string; b: string; folder: string; features: { tasksDir: string; prd: string }[] }) => Promise<void>,
  setup?: (a: string, b: string) => Promise<void>,
): Promise<void> {
  await withRepos(2, async ([a, b], folder) => {
    const fa = await addTasks(a!, "fa", ["a1"]);
    const fb = await addTasks(b!, "fb", ["b1"]);
    await setup?.(a!, b!);
    await commitAll(a!);
    await commitAll(b!);
    await fn({ a: a!, b: b!, folder, features: [fa, fb] });
  });
}

const run = (folder: string, features: { tasksDir: string; prd: string }[], log: (l: string) => void = () => {}) =>
  runSuite({ cwd: folder, features, provider: "fake", merge: true, cliPath, log });

describe("multi-repo suite", () => {
  it("applies each repo's result to its own checkout", () =>
    twoRepos(async ({ a, b, folder, features }) => {
      expect(await run(folder, features)).toBe(0);
      const suite = await loadSuite(folder);
      expect(suite.status).toBe("applied");
      expect(suite.repos.every((r) => r.applied !== undefined)).toBe(true);
      expect(await gitOut(a, ["status", "--porcelain"])).toContain("a1.txt");
      expect(await gitOut(b, ["status", "--porcelain"])).toContain("b1.txt");
      const branch = `suite/${suite.suiteId.slice("suite-".length)}`;
      expect(await gitOut(a, ["rev-parse", "--verify", branch])).not.toBe("");
      expect(await gitOut(b, ["rev-parse", "--verify", branch])).not.toBe("");
      expect(await gitOut(a, ["ls-tree", "-r", "--name-only", branch])).not.toContain("b1.txt");
    }), 120_000);

  it("sends a comment on b/<file> to the e2e fixer, whose commit lands on b's suite branch", () =>
    twoRepos(async ({ a, b, folder, features }) => {
      const hub = new RetryHub();
      const events = new RunEmitter();
      let suiteDir = "";
      const driver = (async () => {
        await hub.whenReviewWaiting();
        const store = new HumanReviewStore(suiteDir);
        await store.add({ file: `${path.basename(b)}/b1.txt`, startLine: 1, body: "change this" });
        hub.decide({ review: "changes" });
        await new Promise((r) => setTimeout(r, 200));
        await hub.whenReviewWaiting();
        hub.decide({ review: "apply" });
      })();
      await withScript(a, { "fixer:fix-r1": { attempts: [{ write: { [`${path.basename(b)}/fixed.txt`]: "fixed\n" } }] } }, async () => {
        const code = await runSuite({
          cwd: folder,
          features,
          provider: "fake",
          merge: true,
          humanReview: true,
          reviewHub: hub,
          reviewEvents: events,
          onReady: (dir) => void (suiteDir = dir),
          cliPath,
          log: () => {},
        });
        expect(code).toBe(0);
      });
      await driver;
      const suite = await loadSuite(folder);
      expect(suite.status).toBe("applied");
      expect(suite.repos.every((r) => r.applied !== undefined)).toBe(true);
      const branch = `suite/${suite.suiteId.slice("suite-".length)}`;
      expect(await gitOut(b, ["ls-tree", "-r", "--name-only", branch])).toContain("fixed.txt");
      expect(await gitOut(a, ["ls-tree", "-r", "--name-only", branch])).not.toContain("fixed.txt");
    }), 180_000);

  it("applies nothing when one repo's checkout is on another branch", () =>
    twoRepos(async ({ a, b, folder, features }) => {
      const lines: string[] = [];
      let switched = false;
      // The suite records its start branch first; the checkout of `b` moves once the integration begins.
      const log = (l: string): void => {
        lines.push(l);
        if (!switched && l.startsWith("merged feature")) {
          switched = true;
          execFileSync("git", ["switch", "-q", "-c", "other"], { cwd: b });
        }
      };
      expect(await run(folder, features, log)).toBe(0);
      expect(lines.join("\n")).toContain(`${path.basename(b)}: not applying: the checkout is on other`);
      expect((await loadSuite(folder)).status).toBe("done");
      expect(await gitOut(a, ["status", "--porcelain"])).not.toContain("a1.txt");
      expect(await gitOut(b, ["status", "--porcelain"])).not.toContain("b1.txt");
    }), 120_000);

  it("runs each repo's validate in its own worktree", () =>
    twoRepos(
      async ({ a, b, folder, features }) => {
        expect(await run(folder, features)).toBe(0);
        expect((await loadSuite(folder)).status).toBe("applied");
        expect(await gitOut(a, ["status", "--porcelain"])).toContain("a1.txt");
        expect(await gitOut(b, ["status", "--porcelain"])).toContain("b1.txt");
        expect(existsSync(path.join(await suiteDirIn(folder), "e2e", "workspace"))).toBe(true);
      },
      async (a, b) => {
        await writeFile(path.join(a, "graph-execution.config.json"), JSON.stringify({ validate: ["test -f a1.txt"], validateAt: "end" }));
        await writeFile(path.join(b, "graph-execution.config.json"), JSON.stringify({ validate: ["test -f b1.txt"], validateAt: "end" }));
      },
    ), 120_000);

  it("keeps a single-repo suite as before", () =>
    withRepos(1, async ([a], folder) => {
      const f1 = await addTasks(a!, "f1", ["x1"]);
      const f2 = await addTasks(a!, "f2", ["y1"]);
      await commitAll(a!);
      expect(await run(folder, [f1, f2])).toBe(0);
      const suite = await loadSuite(folder);
      expect(suite.status).toBe("applied");
      expect(await gitOut(a!, ["status", "--porcelain"])).toContain("x1.txt");
      expect(existsSync(path.join(await suiteDirIn(folder), "e2e", "workspace"))).toBe(false);
    }), 120_000);

  it("saves distinct e2e ports and lists them in the Repos section of the spec", () =>
    twoRepos(async ({ folder, features }) => {
      expect(await run(folder, features)).toBe(0);
      const suite = await loadSuite(folder);
      const ports = suite.e2ePorts!;
      expect(Object.keys(ports).sort()).toEqual(suite.repos.map((r) => r.name).sort());
      expect(new Set(Object.values(ports)).size).toBe(2);
      const spec = await readFile(path.join(await suiteDirIn(folder), "e2e", "spec.md"), "utf8");
      expect(spec.startsWith("# Repos")).toBe(true);
      for (const r of suite.repos) expect(spec).toContain(`| \`${r.name}/\` | ${suite.features.filter((f) => f.repo === r.name).map((f) => f.name).join(", ")} | ${ports[r.name]} |`);
    }), 120_000);

  it("gives the tester and the fixer the Repos section", () =>
    twoRepos(async ({ a, b, folder, features }) => {
      for (const f of features) await writeFile(path.join(f.tasksDir, "test-plan.json"), JSON.stringify({ cases: [{ id: "P1", title: "works", steps: ["run"], expected: "ok", priority: "must" }] }));
      await commitAll(a);
      await commitAll(b);
      prompts.length = 0;
      // No file is changed by two features, so no code review runs: a failing live test starts the fix pass.
      const failing = { attempts: [{ report: { cases: [{ id: "fa-P1", verdict: "fail", evidence: "broken" }, { id: "fb-P1", verdict: "pass", evidence: "ok" }] } }] };
      // The features run with a passing tester; the failing one is swapped in for the in-process e2e phase.
      const passing = { "tester:tester-r0": { attempts: [{ report: { cases: [{ id: "P1", verdict: "pass", evidence: "ok" }] } }] } };
      await withScript(a, passing, async (file) => {
        const [inA, inB] = [defaultSpawn(cliPath, a), defaultSpawn(cliPath, b)];
        const base: SpawnFeature = (args, env, logFile) => (args.some((x) => x.startsWith(b)) ? inB : inA)(args, env, logFile);
        let exits = 0;
        const spawn: SpawnFeature = (...args) => {
          const proc = base(...args);
          return {
            ...proc,
            exited: proc.exited.then(async (code) => {
              if (++exits === features.length) await writeFile(file, JSON.stringify({ "tester:tester-r0": failing }));
              return code;
            }),
          };
        };
        await runSuite({ cwd: folder, features, provider: "fake", merge: true, spawn, cliPath, log: () => {} });
      });
      const suite = await loadSuite(folder);
      for (const key of ["tester:tester-r0", "fixer:fix-r1"]) {
        const p = prompts.find((x) => x.key === key)?.prompt;
        expect(p, key).toContain("# Repos");
        for (const port of Object.values(suite.e2ePorts!)) expect(p).toContain(String(port));
      }
    }), 180_000);

  it("keeps a single-repo suite without the Repos section and ports", () =>
    withRepos(1, async ([a], folder) => {
      const f1 = await addTasks(a!, "f1", ["x1"]);
      const f2 = await addTasks(a!, "f2", ["y1"]);
      await commitAll(a!);
      expect(await run(folder, [f1, f2])).toBe(0);
      const suite = await loadSuite(folder);
      expect(suite.e2ePorts).toBeUndefined();
      expect(await readFile(path.join(await suiteDirIn(folder), "e2e", "spec.md"), "utf8")).not.toContain("# Repos");
    }), 120_000);

  it("writes saved ports into the spec, and runE2e picks ports only when missing", () =>
    twoRepos(async ({ folder, features }) => {
      expect(await run(folder, features)).toBe(0);
      const dir = await suiteDirIn(folder);
      const store = await SuiteStore.load(path.join(dir, "suite.json"));
      await store.update((s) => {
        s.e2ePorts = Object.fromEntries(s.repos.map((r, i) => [r.name, 40001 + i]));
      });
      await buildSuiteInputs({ suiteId: store.state.suiteId, suiteDir: dir, store, log: () => {}, repo: store.state.repos[0]!.root, home: folder });
      const spec = await readFile(path.join(dir, "e2e", "spec.md"), "utf8");
      expect(spec).toContain("| 40001 |");
      expect(spec).toContain("| 40002 |");
      expect(await readFile(new URL("./e2e.ts", import.meta.url), "utf8")).toContain("if (multi && !state.e2ePorts)");
    }), 120_000);
});
