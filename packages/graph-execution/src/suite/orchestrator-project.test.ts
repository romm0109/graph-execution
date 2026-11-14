import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { gitOut } from "../__fixtures__/repo.js";
import { addRepoTasks, cliPath, commitAll, loadSuite, recordingSpawn, suiteDirIn, withProject, withScript } from "../__fixtures__/suite.js";
import { resumeSuite, runSuite } from "./orchestrator.js";
import { defaultSpawn, type SpawnFeature } from "./spawn.js";

/** A test timeout, tripled on Windows: its runners are several times slower at processes and git. */
const slow = (ms: number): number => (process.platform === "win32" ? ms * 3 : ms);

type P = { dir: string; repos: Record<string, string> };
const writes = (file: string) => ({ attempts: [{ write: { [file]: `${file}\n` } }] });
const bothScript = { "task:api1": writes("api.txt"), "task:web1": writes("web.txt") };
const fail = { commit: false, write: {} };
const webFails = { "task:api1": writes("api.txt"), "task:web1": { attempts: [fail, fail, fail] } };
const rid = (suite: { suiteId: string }): string => suite.suiteId.slice("suite-".length);
const status = (repo: string): Promise<string> => gitOut(repo, ["status", "--porcelain"]);
const hasBranch = async (repo: string, branch: string): Promise<boolean> =>
  (await execa("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, reject: false })).exitCode === 0;

async function bothRepos(p: P): Promise<void> {
  await addRepoTasks(p.dir, "api", ["api1"]);
  await addRepoTasks(p.dir, "web", ["web1"]);
  await commitAll(p.dir);
}
const start = (p: P, lines: string[], extra: { merge?: boolean; spawn?: SpawnFeature } = {}) =>
  runSuite({ cwd: p.dir, project: ".", features: [], provider: "fake", concurrency: 2, merge: true, cliPath, log: (l) => lines.push(l), ...extra });

describe("multi-repo suite", () => {
  it("runs a feature in each repo, then applies both", () =>
    withProject(["api", "web"], async (p) => {
      await bothRepos(p);
      const marker = path.join(p.dir, ".git", "validate-marker").replaceAll("\\", "/");
      await writeFile(
        path.join(p.repos.api!, "graph-execution.config.json"),
        JSON.stringify({ validate: [`node -e "require('fs').appendFileSync('${marker}', 'ran ')"`] }),
      );
      await commitAll(p.repos.api!);
      const lines: string[] = [];
      await withScript(p.dir, bothScript, async () => {
        expect(await start(p, lines)).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      const suiteDir = await suiteDirIn(p.dir);
      expect(path.dirname(suiteDir)).toBe(path.join(p.dir, ".graph-execution"));
      expect(suite.status).toBe("applied");
      expect(suite.project).toEqual({ dir: p.dir, name: "billing", contract: path.join(p.dir, "contract.md") });
      expect(suite.repos!.map((r) => [r.name, r.path, r.startBranch])).toEqual([
        ["api", p.repos.api, "main"],
        ["web", p.repos.web, "main"],
      ]);
      for (const r of suite.repos!) expect(r.applied).toEqual({ files: 1, conflicts: [] });
      expect(suite.applied).toEqual({ files: 2, conflicts: [] });

      expect(await status(p.repos.api!)).toContain("api.txt");
      expect(await status(p.repos.api!)).not.toContain("web.txt");
      expect(await status(p.repos.web!)).toContain("web.txt");
      expect(await status(p.repos.web!)).not.toContain("api.txt");
      const branch = `suite/${rid(suite)}`;
      expect(suite.integrationBranch).toBe(branch);
      expect(await hasBranch(p.repos.api!, branch)).toBe(true);
      expect(await hasBranch(p.repos.web!, branch)).toBe(true);
      expect(await hasBranch(p.dir, branch)).toBe(false);
      const api = suite.features.find((f) => f.name === "api")!;
      expect(await hasBranch(p.repos.api!, `graph/${api.runId}`)).toBe(true);
      expect(await hasBranch(p.repos.web!, `graph/${api.runId}`)).toBe(false);
      // The api repo's own config ran its gate command.
      expect(existsSync(marker)).toBe(true);

      for (const f of suite.features) {
        expect(f.repo?.path).toBe(p.repos[f.name]);
        const state = JSON.parse(await readFile(path.join(suiteDir, "features", f.runId, "state.json"), "utf8"));
        const spec = path.join(suiteDir, "specs", `${f.name}.md`);
        expect(state.specPath).toBe(spec);
        const text = await readFile(spec, "utf8");
        expect(text).toContain(`# Spec ${f.name}`);
        expect(text).toContain("## Contract");
        expect(text).toContain("GET /answer returns 42.");
      }
      expect(lines.join("\n")).toContain(`api: applied ${branch} to main: 1 files, 0 conflicts`);
    }), slow(180_000));

  it("a repo without tasks gets suite/<rid> at its starting commit and is not changed", () =>
    withProject(["api", "web"], async (p) => {
      await addRepoTasks(p.dir, "api", ["api1"]);
      await commitAll(p.dir);
      const lines: string[] = [];
      await withScript(p.dir, bothScript, async () => {
        expect(await start(p, lines)).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status).toBe("applied");
      expect(suite.features.map((f) => f.name)).toEqual(["api"]);
      const web = suite.repos!.find((r) => r.name === "web")!;
      expect(web.applied).toEqual({ files: 0, conflicts: [] });
      expect(await gitOut(p.repos.web!, ["rev-parse", `suite/${rid(suite)}`])).toBe(web.startingCommit);
      expect(await gitOut(p.repos.web!, ["rev-parse", "HEAD"])).toBe(web.startingCommit);
      expect(await status(p.repos.web!)).toBe("");
      expect(await status(p.repos.api!)).toContain("api.txt");
      expect(lines).toContain("web: unchanged");
      // Each member repo links the suite, and the link leaves its checkout clean.
      const suiteDir = await suiteDirIn(p.dir);
      for (const r of [p.repos.api!, p.repos.web!]) {
        const link = JSON.parse(await readFile(path.join(r, ".graph-execution", "_projects", `${suite.suiteId}.json`), "utf8"));
        expect(link).toEqual({ suiteDir: path.resolve(suiteDir), project: path.resolve(p.dir) });
      }
    }), slow(180_000));

  it("a failed feature keeps the other running and changes no repo", () =>
    withProject(["api", "web"], async (p) => {
      await bothRepos(p);
      const lines: string[] = [];
      await withScript(p.dir, webFails, async () => {
        expect(await start(p, lines)).toBe(2);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status).toBe("failed");
      expect(Object.fromEntries(suite.features.map((f) => [f.name, f.status]))).toEqual({ api: "done", web: "failed" });
      for (const repo of Object.values(p.repos)) {
        expect(await status(repo)).toBe("");
        expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
        expect(await hasBranch(repo, `suite/${rid(suite)}`)).toBe(false);
      }
      expect(lines.join("\n")).toContain("failed features: web; no repo was changed");
    }), slow(180_000));

  it("applies nothing when a repo moved during the suite", () =>
    withProject(["api", "web"], async (p) => {
      await bothRepos(p);
      const base = defaultSpawn(cliPath, p.dir);
      let exits = 0;
      const spawn: SpawnFeature = (...args) => {
        const proc = base(...args);
        return {
          ...proc,
          exited: proc.exited.then(async (code) => {
            if (++exits === 2) {
              await writeFile(path.join(p.repos.web!, "mine.txt"), "mine\n");
              await commitAll(p.repos.web!);
            }
            return code;
          }),
        };
      };
      const lines: string[] = [];
      await withScript(p.dir, bothScript, async () => {
        expect(await start(p, lines, { spawn })).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status).toBe("done");
      expect(suite.applied).toBeUndefined();
      for (const repo of Object.values(p.repos)) {
        expect(await status(repo)).toBe("");
        expect(await hasBranch(repo, `suite/${rid(suite)}`)).toBe(true);
      }
      for (const r of suite.repos!) expect(r.applied).toBeUndefined();
      const line = lines.find((l) => l.includes("web: the checkout moved from"));
      expect(line).toContain("results left on suite/");
    }), slow(180_000));

  it("--no-merge leaves every result on suite/<rid>", () =>
    withProject(["api", "web"], async (p) => {
      await bothRepos(p);
      const lines: string[] = [];
      await withScript(p.dir, bothScript, async () => {
        expect(await start(p, lines, { merge: false })).toBe(0);
      });
      const suite = await loadSuite(p.dir);
      expect(suite.status).toBe("done");
      const branch = `suite/${rid(suite)}`;
      for (const [name, repo] of Object.entries(p.repos)) {
        expect(await status(repo)).toBe("");
        expect(lines).toContain(`${name}: the result is on ${branch}`);
        expect(await gitOut(repo, ["show", `${branch}:${name}.txt`])).toBe(`${name}.txt`);
      }
    }), slow(180_000));

  it("a detached HEAD is refused before anything is created, unless --no-merge", () =>
    withProject(["api", "web"], async (p) => {
      await bothRepos(p);
      await gitOut(p.repos.web!, ["checkout", "-q", "--detach"]);
      await expect(start(p, [])).rejects.toThrow("web: detached HEAD; check out a branch, or pass --no-merge");
      expect(existsSync(path.join(p.dir, ".graph-execution"))).toBe(false);
    }));

  it("resume restarts the failed feature in its repo and never applies a repo twice", () =>
    withProject(["api", "web"], async (p) => {
      await bothRepos(p);
      await withScript(p.dir, webFails, async (file) => {
        expect(await start(p, [])).toBe(2);
        await writeFile(file, JSON.stringify({ "task:web1": writes("web.txt") }));
        const suiteFile = path.join(await suiteDirIn(p.dir), "suite.json");
        const saved = JSON.parse(await readFile(suiteFile, "utf8"));
        saved.repos.find((r: { name: string }) => r.name === "api").applied = { files: 0, conflicts: [] };
        await writeFile(suiteFile, JSON.stringify(saved));

        const starts: string[][] = [];
        const lines: string[] = [];
        expect(await resumeSuite({ cwd: p.dir, spawn: recordingSpawn(p.dir, starts), log: (l) => lines.push(l) })).toBe(0);
        const suite = await loadSuite(p.dir);
        expect(suite.status).toBe("applied");
        expect(starts).toEqual([["--resume", "--run", suite.features.find((f) => f.name === "web")!.runId]]);
        // Recorded as applied, so its checkout is not touched again.
        expect(await status(p.repos.api!)).toBe("");
        expect(await status(p.repos.web!)).toContain("web.txt");
        expect(suite.repos!.map((r) => r.applied?.files)).toEqual([0, 1]);
        await expect(resumeSuite({ cwd: p.dir, log: () => {} })).rejects.toThrow(/already finished/);
      });
    }), slow(180_000));
});
