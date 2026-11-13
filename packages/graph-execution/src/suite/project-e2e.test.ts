import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { addRepoTasks, cliPath, commitAll, loadSuite, recordingSpawn, suiteDirIn, until, withProject, withScript } from "../__fixtures__/suite.js";
import { EXIT_ABORT } from "../state/errors.js";
import { jointDirOf } from "./joint.js";
import { resumeSuite, runSuite } from "./orchestrator.js";
import { defaultSpawn, type SpawnFeature } from "./spawn.js";

/** A test timeout, tripled on Windows: its runners are several times slower at processes and git. */
const slow = (ms: number): number => (process.platform === "win32" ? ms * 3 : ms);

// The joint phase runs in this process: the providers it gets are wrapped to record every prompt and where it ran.
const prompts = vi.hoisted(() => [] as { key: string; prompt: string; cwd: string; repos: string[] }[]);
vi.mock("../providers/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../providers/index.js")>();
  const { existsSync: exists } = await import("node:fs");
  const { join } = await import("node:path");
  return {
    ...mod,
    getProvider: async (...args: Parameters<typeof mod.getProvider>) => {
      const provider = await mod.getProvider(...args);
      return {
        ...provider,
        run: (opts: Parameters<typeof provider.run>[0]) => {
          prompts.push({
            key: `${opts.role}:${opts.label}`,
            prompt: opts.prompt,
            cwd: opts.cwd,
            repos: ["api", "web"].filter((name) => exists(join(opts.cwd, "repos", name, ".git"))),
          });
          return provider.run(opts);
        },
      };
    },
  };
});

type P = { dir: string; repos: Record<string, string> };
const writes = (file: string) => ({ attempts: [{ write: { [file]: `${file}\n` } }] });
const tasks = { "task:a1": writes("a1.txt"), "task:w1": writes("w1.txt") };
const status = (repo: string): Promise<string> => gitOut(repo, ["status", "--porcelain"]);
const worktrees = async (repo: string): Promise<number> =>
  (await gitOut(repo, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)!.length;
const validation = (suite: Awaited<ReturnType<typeof loadSuite>>) =>
  suite.joint?.validation.map(({ repo, ok, commands }) => ({ repo, ok, commands }));

async function project(p: P): Promise<void> {
  await addRepoTasks(p.dir, "api", ["a1"]);
  await addRepoTasks(p.dir, "web", ["w1"]);
  await commitAll(p.dir);
}
const start = (p: P, lines: string[], extra: { merge?: boolean; signal?: AbortSignal; spawn?: SpawnFeature } = {}) =>
  runSuite({ cwd: p.dir, project: ".", features: [], provider: "fake", concurrency: 2, merge: true, cliPath, log: (l) => lines.push(l), ...extra });

describe("multi-repo suite: joint phase", () => {
  beforeEach(() => {
    prompts.length = 0;
  });

  it("validates each repo, reviews the combined diff and tests in a checkout of every repo", () =>
    withProject(["api", "web"], async (p) => {
      const check = `node -e "require('fs').accessSync('w1.txt')"`;
      await writeFile(path.join(p.repos.web!, "graph-execution.config.json"), JSON.stringify({ validate: [check] }));
      await writeFile(path.join(p.repos.web!, "REVIEW.md"), "No console.log in web.\n");
      await commitAll(p.repos.web!);
      await writeFile(
        path.join(p.dir, "test-plan.json"),
        JSON.stringify({ cases: [{ id: "c1", title: "web has w1", steps: [`cd repos/web && ${check}`], expected: "exit code 0", priority: "must" }] }),
      );
      await project(p);
      const lines: string[] = [];
      const script = {
        ...tasks,
        "tester:tester-r0": { attempts: [{ report: { cases: [{ id: "c1", verdict: "pass", evidence: "exit code 0" }] } }] },
      };
      await withScript(p.dir, script, async () => {
        expect(await start(p, lines), lines.join("\n")).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      const suiteDir = await suiteDirIn(p.dir);
      const branch = `suite/${suite.suiteId.slice("suite-".length)}`;
      expect(suite.status).toBe("applied");
      expect(validation(suite)).toEqual([
        { repo: "api", ok: true, commands: 0 },
        { repo: "web", ok: true, commands: 1 },
      ]);
      expect(suite.joint!.base).toEqual({
        api: await gitOut(p.repos.api!, ["rev-parse", branch]),
        web: await gitOut(p.repos.web!, ["rev-parse", branch]),
      });
      expect(lines).toContain(`validating ${branch} in api, web before the review`);

      const reviewer = prompts.find((x) => x.key === "reviewer:code-r0")!;
      for (const text of ["# Contract", "GET /answer returns 42.", "# Repo api", "# Spec api", "# Repo web", "# Spec web"]) {
        expect(reviewer.prompt).toContain(text);
      }
      expect(reviewer.prompt).toContain("diff --git a/api/a1.txt b/api/a1.txt");
      expect(reviewer.prompt).toContain("diff --git a/web/w1.txt b/web/w1.txt");
      expect(reviewer.prompt).toContain("## Repositories");
      expect(reviewer.prompt).toContain("## web\n\nNo console.log in web.");
      const tester = prompts.find((x) => x.key === "tester:tester-r0")!;
      expect(tester.cwd).toBe(path.join(suiteDir, "worktrees", "review-tester-r0"));
      expect(tester.repos).toEqual(["api", "web"]);
      expect(tester.prompt).toContain("- web/w1.txt");
      expect(tester.prompt).toContain(`cd repos/web && ${check}`);

      // Both repos applied; the joint worktrees and the reviewers' checkouts are gone.
      expect(await status(p.repos.api!)).toContain("a1.txt");
      expect(await status(p.repos.web!)).toContain("w1.txt");
      expect(existsSync(jointDirOf(suiteDir))).toBe(false);
      for (const repo of Object.values(p.repos)) expect(await worktrees(repo)).toBe(1);
      // Nothing was committed to the project folder.
      expect(await gitOut(p.dir, ["log", "--format=%s"])).not.toContain("fake:");
    }), slow(240_000));

  it("runs only the validation when the project turns e2eReview off", () =>
    withProject(["api", "web"], async (p) => {
      await writeFile(path.join(p.dir, "graph-execution.config.json"), JSON.stringify({ e2eReview: false }));
      await project(p);
      const lines: string[] = [];
      await withScript(p.dir, tasks, async () => {
        expect(await start(p, lines), lines.join("\n")).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status).toBe("applied");
      expect(prompts.filter((x) => x.key.startsWith("reviewer:") || x.key.startsWith("tester:"))).toEqual([]);
      expect(validation(suite)).toEqual([]);
      expect(suite.joint!.base).toHaveProperty("api");
      for (const r of suite.repos!) expect(r.applied).toEqual({ files: 1, conflicts: [] });
    }), slow(240_000));

  it("fails with open findings, changes no repo and keeps the joint worktrees", () =>
    withProject(["api", "web"], async (p) => {
      await writeFile(path.join(p.dir, "graph-execution.config.json"), JSON.stringify({ fixPasses: 0 }));
      await project(p);
      const blocker = { id: "F1", severity: "blocker", file: "web/w1.txt", line: 1, description: "Wrong.", failureScenario: "It is wrong.", status: "open" };
      const lines: string[] = [];
      await withScript(p.dir, { ...tasks, "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] } }, async () => {
        expect(await start(p, lines), lines.join("\n")).toBe(1);
      });
      const suite = await loadSuite(p.dir);
      const suiteDir = await suiteDirIn(p.dir);
      expect(suite.status).toBe("failed");
      expect(lines.join("\n")).toContain("joint review failed: open findings in");
      for (const repo of Object.values(p.repos)) expect(await status(repo)).toBe("");
      expect(existsSync(path.join(jointDirOf(suiteDir), "repos", "web", ".git"))).toBe(true);
    }), slow(240_000));

  it("a joint fix pass commits in the repos, not in the joint folder, and is applied", () =>
    withProject(["api", "web"], async (p) => {
      await writeFile(path.join(p.dir, "graph-execution.config.json"), JSON.stringify({ fixPasses: 1 }));
      await project(p);
      const blocker = { id: "F1", severity: "blocker", file: "web/w1.txt", line: 1, description: "Wrong.", failureScenario: "It is wrong.", status: "open" };
      const lines: string[] = [];
      // The feature runs read the same script: their fixers write repos/api/joint-fix.txt inside their own repo, a
      // different file from the joint fixer's (the api repo's joint-fix.txt).
      const script = {
        ...tasks,
        "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
        "fixer:fix-r1": { attempts: [{ write: { "repos/api/joint-fix.txt": "x\n" } }] },
      };
      await withScript(p.dir, script, async () => {
        expect(await start(p, lines), lines.join("\n")).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status, lines.join("\n")).toBe("applied");
      // The fake fixer commits in the repo it wrote to, not in the joint folder.
      expect(await status(p.repos.api!)).toMatch(/^\?\? joint-fix\.txt$/m);
      expect(lines.join("\n")).not.toContain("the fixer made no commit");
    }), slow(240_000));

  it("a joint fix pass that gives up ends the suite failed with its error and changes no repo", () =>
    withProject(["api", "web"], async (p) => {
      await writeFile(path.join(p.dir, "graph-execution.config.json"), JSON.stringify({ fixPasses: 1 }));
      await project(p);
      const blocker = { id: "F1", severity: "blocker", file: "web/w1.txt", line: 1, description: "Wrong.", failureScenario: "It is wrong.", status: "open" };
      const noCommit = { attempts: Array.from({ length: 10 }, () => ({ commit: false })) };
      const lines: string[] = [];
      await withScript(p.dir, { ...tasks, "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] }, "fixer:fix-r1": noCommit }, async () => {
        expect(await start(p, lines), lines.join("\n")).toBe(EXIT_ABORT);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status).toBe("failed");
      expect(suite.error).toContain("the fixer made no commit");
      expect(lines.join("\n")).toContain("graph-execution suite --resume");
      for (const repo of Object.values(p.repos)) expect(await status(repo)).toBe("");
    }), slow(240_000));

  it("resume continues a stopped joint phase without restarting a feature and applies each repo once", () =>
    withProject(["api", "web"], async (p) => {
      await project(p);
      const controller = new AbortController();
      const lines: string[] = [];
      await withScript(p.dir, tasks, async (file) => {
        // The features' own reviewers read the same script: the joint reviewer's hang goes in once both have ended.
        const base = defaultSpawn(cliPath, p.dir);
        let exits = 0;
        const spawn: SpawnFeature = (...args) => {
          const proc = base(...args);
          return {
            ...proc,
            exited: proc.exited.then(async (code) => {
              if (++exits === 2) await writeFile(file, JSON.stringify({ "reviewer:code-r0": { attempts: [{ hang: true }] } }));
              return code;
            }),
          };
        };
        const first = start(p, lines, { signal: controller.signal, spawn });
        await until(() => prompts.some((x) => x.key === "reviewer:code-r0"));
        controller.abort();
        expect(await first, lines.join("\n")).toBe(EXIT_ABORT);
        const stopped = await loadSuite(p.dir);
        expect(stopped.status).toBe("aborted");
        const jointBase = stopped.joint!.base;
        const suiteDir = await suiteDirIn(p.dir);
        expect(existsSync(path.join(jointDirOf(suiteDir), "repos", "api", ".git"))).toBe(true);

        await writeFile(file, JSON.stringify(tasks));
        const starts: string[][] = [];
        expect(await resumeSuite({ cwd: p.dir, spawn: recordingSpawn(p.dir, starts), log: (l) => lines.push(l) }), lines.join("\n")).toBe(0);
        expect(starts).toEqual([]);
        const suite = await loadSuite(p.dir);
        expect(suite.status).toBe("applied");
        expect(suite.joint!.base).toEqual(jointBase);
        for (const [name, repo] of Object.entries(p.repos)) {
          expect(await status(repo)).not.toBe("");
          expect(suite.repos!.find((r) => r.name === name)!.applied).toEqual({ files: 1, conflicts: [] });
        }
        expect(existsSync(jointDirOf(suiteDir))).toBe(false);
        expect(JSON.parse(await readFile(path.join(suiteDir, "reports", "round0", "code.json"), "utf8")).findings).toEqual([]);
      });
    }), slow(240_000));
});
