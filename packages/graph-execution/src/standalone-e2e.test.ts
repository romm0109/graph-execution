/**
 * End-to-end checks that the README's features work with the npm package alone, without graph-manager: each test runs
 * the built CLI (`dist/cli.js`, built by vitest.global-setup.ts) with `--provider fake` in a throwaway repository.
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "./__fixtures__/repo.js";
import { FAKE_PROMPTS_ENV, FAKE_SCRIPT_ENV } from "./providers/fake.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const fixture = (name: string): string => path.join(root, "src", "__fixtures__", name);
const spec = fixture("spec.md");

/** A test timeout, tripled on Windows: its runners are several times slower at processes and git. */
const slow = (ms: number): number => (process.platform === "win32" ? ms * 3 : ms);

const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  execa("node", [cli, ...args], { cwd, env, reject: false });

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await tempRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const runIdOf = (stdout: string): string => {
  const id = /Run (\S+):/.exec(stdout)?.[1];
  expect(id, stdout).toBeDefined();
  return id!;
};
const readState = async (repo: string, id: string) =>
  JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));

describe("graph-execution without graph-manager (fake provider, built CLI)", () => {
  it("runs with a reviewers file that adds a Security diff reviewer", () =>
    withRepo(async (repo) => {
      const file = path.join(repo, ".git", "reviewers.json");
      const reviewers = [
        { id: "code", type: "diff", name: "Code review", instructions: "Review the diff.", repoFile: "REVIEW.md" },
        { id: "security", type: "diff", name: "Security", instructions: "Look for security bugs.", repoFile: "SECURITY_REVIEW.md", provider: "fake" },
      ];
      await writeFile(file, JSON.stringify({ reviewers }));
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--reviewers", file], repo);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const id = runIdOf(res.stdout);
      const runDir = path.join(repo, ".graph-execution", id);
      expect(JSON.parse(await readFile(path.join(runDir, "reviewers.json"), "utf8")).reviewers[1].id).toBe("security");
      // run.log is written only by a --web run; a foreground run prints the reviewer in its log and summary.
      expect(res.stdout).toContain("Security");
      expect(existsSync(path.join(runDir, "reports", "round0", "security.json"))).toBe(true);
    }), slow(60_000));

  it("saves the run option flags in state.json and keeps the result on graph/<id> with --no-merge", () =>
    withRepo(async (repo) => {
      const res = await run(
        [fixture("diamond"), "--spec", spec, "--provider", "fake", "--concurrency", "1", "--model", "m", "--no-merge",
          "--validate-at", "end", "--validate-parallel", "--idle-timeout", "5"],
        repo,
      );
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const id = runIdOf(res.stdout);
      const state = await readState(repo, id);
      expect(state.overrides).toMatchObject({ validateAt: "end", validateParallel: true, idleTimeoutMinutes: 5 });
      expect(await gitOut(repo, ["status", "--short"])).toBe("");
      expect((await gitOut(repo, ["ls-tree", "--name-only", `graph/${id}`])).split("\n")).toEqual(
        expect.arrayContaining(["1.txt", "2.txt", "3.txt", "4.txt"]),
      );
    }), slow(60_000));

  it("passes the test plan's case ids to the live tester", () =>
    withRepo(async (repo) => {
      const tasks = path.join(repo, "plan");
      await cp(fixture("plan-ok"), tasks, { recursive: true });
      await gitOut(repo, ["add", "-A"]);
      await gitOut(repo, ["commit", "-q", "-m", "tasks"]);
      const prompts = await mkdtemp(path.join(repo, ".git", "prompts-"));
      const script = path.join(repo, ".git", "fake-script.json");
      const pass = (id: string) => ({ id, verdict: "pass", evidence: "ok" });
      await writeFile(script, JSON.stringify({ "tester:tester-r0": { attempts: [{ report: { cases: [pass("P1"), pass("P2")] } }] } }));
      const res = await run([tasks, "--spec", spec, "--provider", "fake"], repo, {
        [FAKE_PROMPTS_ENV]: prompts,
        [FAKE_SCRIPT_ENV]: script,
      });
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const testerPrompts = (await readdir(prompts)).filter((n) => n.startsWith("tester"));
      expect(testerPrompts.length).toBeGreaterThan(0);
      const prompt = await readFile(path.join(prompts, testerPrompts[0]!), "utf8");
      expect(prompt).toContain("P1");
      expect(prompt).toContain("P2");
      expect(res.stdout).toContain("Test plan: 2/2 passed");
    }), slow(60_000));

  it("exits 2 when a task fails, then --resume with the fixed script applies the run", () =>
    withRepo(async (repo) => {
      const script = path.join(repo, ".git", "fake-script.json");
      await writeFile(script, JSON.stringify({ "task:1": { attempts: [{ commit: false, write: {} }] } }));
      const env = { [FAKE_SCRIPT_ENV]: script };
      const failed = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--attempts", "1"], repo, env);
      expect(failed.exitCode, failed.stdout + failed.stderr).toBe(2);
      const id = runIdOf(failed.stdout);
      await writeFile(script, "{}");
      const resumed = await run(["--resume"], repo, env);
      expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
      expect((await readState(repo, id)).status).toBe("applied");
      expect(existsSync(path.join(repo, "4.txt"))).toBe(true);
    }), slow(90_000));

  it("lists a finished run as applied, and open --run says it has no live page", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const id = runIdOf(res.stdout);
      const list = await run(["list"], repo);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain(id);
      expect(list.stdout).toContain("applied");
      const open = await run(["open", "--run", id], repo);
      expect(open.exitCode).toBe(2);
      expect(open.stderr).toContain("has no live page");
    }), slow(60_000));

  it("prints the README with readme --print", async () => {
    const res = await run(["readme", "--print"], root);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("# graph-execution");
  });

  it("runs a suite of two features in the foreground without --web", () =>
    withRepo(async (repo) => {
      for (const name of ["a", "b"]) {
        await cp(fixture("diamond"), path.join(repo, name), { recursive: true });
        await cp(spec, path.join(repo, `PRD-${name}.md`));
      }
      await gitOut(repo, ["add", "-A"]);
      await gitOut(repo, ["commit", "-q", "-m", "features"]);
      const res = await run(["suite", "--feature", "a:PRD-a.md", "--feature", "b:PRD-b.md", "--provider", "fake"], repo);
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const suiteDir = (await readdir(path.join(repo, ".graph-execution"))).find((n) => n.startsWith("suite-"));
      expect(suiteDir).toBeDefined();
      const suite = JSON.parse(await readFile(path.join(repo, ".graph-execution", suiteDir!, "suite.json"), "utf8"));
      expect(suite.status).toBe("applied");
    }), slow(120_000));
});
