import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { CONFIG_FILE } from "../config/config.js";
import { FAKE_LOG_ENV, FAKE_PID_FILE, FAKE_SCRIPT_ENV } from "../providers/fake.js";
import { reconcile } from "./resume.js";
import { KILL_AT_ENV, LOCK_FILE, type RunState, stateSchema } from "./state.js";

// Runs the built entry; vitest.global-setup.ts builds dist/ before the suite.
const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const diamond = path.join(root, "src", "__fixtures__", "diamond");
const fixtureSpec = path.join(root, "src", "__fixtures__", "spec.md");

const blocker = {
  id: "F1",
  severity: "blocker",
  file: "1.txt",
  description: "Wrong content.",
  failureScenario: "Reading 1.txt returns the task id instead of the result.",
  status: "open",
};

/** The diamond with a validation gate, one blocker in round 0, one fix pass and a clean re-review. */
const FULL_FLOW = {
  config: { validate: ['node -e "process.exit(0)"'] },
  script: { "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] } },
};

interface Repo {
  dir: string;
  spec: string;
  script: string;
  calls: string;
}

async function setupRepo(config: unknown, script: unknown): Promise<Repo> {
  const dir = await tempRepo();
  const git = path.join(dir, ".git");
  const repo = {
    dir,
    spec: path.join(git, "spec.md"),
    script: path.join(git, "fake-script.json"),
    calls: path.join(git, "fake-calls.log"),
  };
  await copyFile(fixtureSpec, repo.spec);
  if (config !== undefined) await writeFile(path.join(dir, CONFIG_FILE), JSON.stringify(config));
  await writeFile(repo.script, JSON.stringify(script));
  return repo;
}

const cliRun = (repo: Repo, args: string[], env: Record<string, string> = {}) =>
  execa("node", [cli, ...args], {
    cwd: repo.dir,
    env: { [FAKE_SCRIPT_ENV]: repo.script, [FAKE_LOG_ENV]: repo.calls, ...env },
    reject: false,
  });

const start = (repo: Repo, env: Record<string, string> = {}) =>
  cliRun(repo, [diamond, "--spec", repo.spec, "--provider", "fake"], env);

const resumeCli = (repo: Repo, args: string[] = []) => cliRun(repo, ["--resume", ...args]);

async function onlyRun(repo: Repo): Promise<{ runId: string; runDir: string }> {
  const runs = await readdir(path.join(repo.dir, ".graph-execution"));
  expect(runs).toHaveLength(1);
  return { runId: runs[0]!, runDir: path.join(repo.dir, ".graph-execution", runs[0]!) };
}

const readState = async (runDir: string): Promise<RunState> =>
  stateSchema.parse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));

const readCalls = async (repo: Repo): Promise<string[]> =>
  existsSync(repo.calls) ? (await readFile(repo.calls, "utf8")).split("\n").filter(Boolean) : [];

const tree = (repo: Repo, runId: string): Promise<string> => gitOut(repo.dir, ["rev-parse", `graph/${runId}^{tree}`]);

async function withRepo<T>(config: unknown, script: unknown, fn: (repo: Repo) => Promise<T>): Promise<T> {
  const repo = await setupRepo(config, script);
  try {
    return await fn(repo);
  } finally {
    await rm(repo.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Kills the run hard after the n-th state save, resumes it and checks the outcome; false once n is past the end. */
async function killAndResume(n: number, expectedTree: string): Promise<boolean> {
  return withRepo(FULL_FLOW.config, FULL_FLOW.script, async (repo) => {
    const killed = await start(repo, { [KILL_AT_ENV]: String(n) });
    if (killed.exitCode === 0) return false;
    expect(killed.signal, `kill at save ${n}: ${killed.stdout}\n${killed.stderr}`).toBe("SIGKILL");

    const { runId, runDir } = await onlyRun(repo);
    const before = await readState(runDir);
    const merged = Object.entries(before.tasks)
      .filter(([, t]) => t.status === "merged")
      .map(([id]) => id);
    await rm(repo.calls, { force: true });

    const resumed = await resumeCli(repo);
    expect(resumed.exitCode, `resume after save ${n}: ${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(await tree(repo, runId)).toBe(expectedTree);

    // No merged task ran again, and every task was merged exactly once.
    const calls = await readCalls(repo);
    for (const id of merged) expect(calls, `save ${n}`).not.toContain(`task:${id}`);
    const merges = (await gitOut(repo.dir, ["log", "--merges", "--format=%s", `graph/${runId}`])).split("\n").sort();
    expect(merges, `save ${n}`).toEqual(["Merge task 1", "Merge task 2", "Merge task 3", "Merge task 4"]);
    // A report written before the kill was not regenerated.
    const { review } = before;
    if (review.phase === "review") {
      if (review.reports.code) expect(calls).not.toContain(`reviewer:code-r${review.round}`);
      if (review.reports.tester) expect(calls).not.toContain(`tester:tester-r${review.round}`);
    }
    if (review.phase === "done") expect(calls.filter((c) => !c.startsWith("task:"))).toEqual([]);

    const after = await readState(runDir);
    expect(after.review.phase).toBe("done");
    expect(Object.values(after.tasks).map((t) => t.status)).toEqual(["merged", "merged", "merged", "merged"]);
    expect(existsSync(path.join(runDir, LOCK_FILE))).toBe(false);
    return true;
  });
}

describe("resume", () => {
  it("finishes a run killed at any state save with the uninterrupted run's tree", async () => {
    const expectedTree = await withRepo(FULL_FLOW.config, FULL_FLOW.script, async (repo) => {
      const res = await start(repo);
      expect(res.exitCode, res.stdout).toBe(0);
      const { runId } = await onlyRun(repo);
      const calls = await readCalls(repo);
      // The flow really covers a fix pass and a re-review.
      expect(calls).toEqual(expect.arrayContaining(["fixer:fix-r1", "reviewer:code-r1", "tester:tester-r1"]));
      return tree(repo, runId);
    });

    const BATCH = 6;
    let tested = 0;
    for (let first = 1; ; first += BATCH) {
      const results = await Promise.all(
        Array.from({ length: BATCH }, (_, i) => killAndResume(first + i, expectedTree)),
      );
      tested += results.filter(Boolean).length;
      if (results.includes(false)) break;
    }
    // Sanity check: the flow has many transitions, each of them was a kill point.
    expect(tested).toBeGreaterThan(20);
  }, 600_000);

  it("refuses to resume when the spec changed, naming it", () =>
    withRepo(undefined, { "task:2": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }] } }, async (repo) => {
      expect((await start(repo)).exitCode).toBe(2);
      await writeFile(repo.spec, "# Changed spec\n");
      const res = await resumeCli(repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("the spec changed");
      expect(res.stderr).not.toContain("config file");
    }));

  it("refuses to resume when the config changed, naming it", () =>
    withRepo(undefined, { "task:2": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }] } }, async (repo) => {
      expect((await start(repo)).exitCode).toBe(2);
      await writeFile(path.join(repo.dir, CONFIG_FILE), JSON.stringify({ attempts: 5 }));
      const res = await resumeCli(repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("the config file changed");
    }));

  it("refuses a second resume while the lock's PID is alive, and takes over a stale lock", () =>
    withRepo(undefined, { "task:2": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }] } }, async (repo) => {
      expect((await start(repo)).exitCode).toBe(2);
      const { runId, runDir } = await onlyRun(repo);
      // The aborted run released its lock.
      expect(existsSync(path.join(runDir, LOCK_FILE))).toBe(false);

      await writeFile(path.join(runDir, LOCK_FILE), `${process.pid}\n`);
      const refused = await resumeCli(repo, ["--run", runId]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain(`is locked by the running process ${process.pid}`);
      expect((await readState(runDir)).tasks["2"]!.status).toBe("failed");

      await writeFile(repo.script, "{}");
      const dead = await execa("node", ["-e", "process.stdout.write(String(process.pid))"]);
      await writeFile(path.join(runDir, LOCK_FILE), `${dead.stdout}\n`);
      const res = await resumeCli(repo, ["--run", runId]);
      expect(res.exitCode, res.stdout).toBe(0);
      expect(existsSync(path.join(runDir, LOCK_FILE))).toBe(false);
    }));

  it("gives a failed task a fresh 3 attempts", () =>
    withRepo(undefined, { "task:1": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }] } }, async (repo) => {
      expect((await start(repo)).exitCode).toBe(2);
      const { runId, runDir } = await onlyRun(repo);
      expect((await readState(runDir)).tasks["1"]).toMatchObject({ status: "failed", attempts: 3 });

      // Succeeds only at the third attempt of the resumed process.
      await writeFile(repo.script, JSON.stringify({ "task:1": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, {}] } }));
      const res = await resumeCli(repo);
      expect(res.exitCode, res.stdout).toBe(0);
      expect((await readState(runDir)).tasks["1"]).toMatchObject({ status: "merged", attempts: 3 });
      expect((await gitOut(repo.dir, ["ls-tree", "--name-only", `graph/${runId}`])).split("\n")).toContain("4.txt");
    }));

  it("keeps the attempt counter of a task interrupted while running", () =>
    withRepo(undefined, { "task:1": { attempts: [{ commit: false, write: {} }, { hang: true }] } }, async (repo) => {
      const child = start(repo);
      const runsDir = path.join(repo.dir, ".graph-execution");
      let pidFile: string | undefined;
      while (!pidFile) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const runIds = await readdir(runsDir).catch(() => []);
        const candidate = runIds[0] && path.join(runsDir, runIds[0], "worktrees", "task-1-a2", FAKE_PID_FILE);
        if (candidate && existsSync(candidate)) pidFile = candidate;
      }
      child.kill("SIGINT");
      expect((await child).exitCode).toBe(2);
      const { runDir } = await onlyRun(repo);
      expect((await readState(runDir)).tasks["1"]).toMatchObject({ status: "running", attempts: 2 });

      // Attempts 2 and 3 are left: two more failures exhaust them.
      await writeFile(repo.script, JSON.stringify({ "task:1": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, {}] } }));
      const res = await resumeCli(repo);
      expect(res.exitCode).toBe(2);
      expect(res.stdout).toContain("task 1 failed after 2 attempts");
      expect((await readState(runDir)).tasks["1"]).toMatchObject({ status: "failed", attempts: 3 });
      expect(existsSync(path.join(runDir, "worktrees", "task-1-a2"))).toBe(false);
    }));
});

describe("reconcile", () => {
  it("lets git win: a merged task whose merge commit is gone goes back to pending, then resume redoes it", () =>
    withRepo(undefined, {}, async (repo) => {
      expect((await start(repo)).exitCode).toBe(0);
      const { runId, runDir } = await onlyRun(repo);
      const state = await readState(runDir);
      // Drop task 4's merge from the integration branch, behind the state's back (a successful run removed its worktree).
      await execa("git", ["branch", "-f", `graph/${runId}`, `${state.tasks["4"]!.mergeCommit!}^1`], { cwd: repo.dir });

      const repaired = await reconcile(structuredClone(state), repo.dir);
      expect(repaired.tasks["4"]).toMatchObject({ status: "pending", attempts: 0, branch: state.tasks["4"]!.branch });
      for (const id of ["1", "2", "3"]) expect(repaired.tasks[id]).toEqual(state.tasks[id]);

      // The reviews were of a tree that no longer exists: the review phase starts over.
      expect(repaired.review).toEqual({ phase: "validate", round: 0, validationRounds: 0, reports: {}, humanRound: 0, budgetBase: 0 });
      expect(existsSync(path.join(runDir, "reports"))).toBe(false);

      await rm(repo.calls, { force: true });
      const res = await resumeCli(repo);
      expect(res.exitCode, res.stdout).toBe(0);
      const calls = await readCalls(repo);
      expect(calls.filter((c) => c.startsWith("task:"))).toEqual(["task:4"]);
      expect(calls).toContain("reviewer:code-r0");
      expect((await gitOut(repo.dir, ["ls-tree", "--name-only", `graph/${runId}`])).split("\n")).toContain("4.txt");
    }));

  it("marks a merging task merged when its branch is already on the integration branch, and re-adds a missing integration worktree", () =>
    withRepo(undefined, {}, async (repo) => {
      expect((await start(repo)).exitCode).toBe(0);
      const { runDir } = await onlyRun(repo);
      const state = await readState(runDir);
      const mergeCommit = state.tasks["2"]!.mergeCommit!;
      const integration = path.join(runDir, "worktrees", "integration");
      await rm(integration, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      const broken = structuredClone(state);
      Object.assign(broken.tasks["2"]!, { status: "merging", worktree: path.join(runDir, "worktrees", "task-2-a1") });
      delete broken.tasks["2"]!.mergeCommit;
      Object.assign(broken.tasks["3"]!, { status: "running", attempts: 1 });

      const repaired = await reconcile(broken, repo.dir);
      expect(repaired.tasks["2"]).toEqual({ status: "merged", attempts: 1, branch: state.tasks["2"]!.branch, mergeCommit, baseSha: state.tasks["2"]!.baseSha });
      expect(repaired.tasks["3"]).toMatchObject({ status: "pending", attempts: 1 });
      expect(await gitOut(repo.dir, ["branch", "--list", state.tasks["3"]!.branch!])).toBe("");
      expect(await gitOut(integration, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(state.integrationBranch);
    }));
});
