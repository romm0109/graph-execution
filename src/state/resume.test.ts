import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { CONFIG_FILE } from "../config/config.js";
import { FAKE_PID_FILE } from "../providers/fake.js";
import { findRun, reconcile } from "./resume.js";
import { LOCK_FILE } from "./state.js";
import { start, resumeCli, onlyRun, readState, readCalls, withRepo } from "../__fixtures__/resume.js";

describe("resume", () => {

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
      // A finished run deletes its task branches; task 2's is put back at its tip.
      await execa("git", ["branch", state.tasks["2"]!.branch!, `${mergeCommit}^2`], { cwd: repo.dir });
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

describe("findRun", () => {
  const mk = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), "{}");
  };

  it("finds runs under a custom runs root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ge-root-"));
    try {
      await mk(path.join(root, "20260101-000000-aaaa"));
      await mk(path.join(root, "20260102-000000-bbbb"));
      const env = { GRAPH_EXECUTION_RUNS_ROOT: root };
      expect(await findRun("/nowhere", undefined, env)).toBe(path.join(root, "20260102-000000-bbbb"));
      expect(await findRun("/nowhere", "20260101-000000-aaaa", env)).toBe(path.join(root, "20260101-000000-aaaa"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores suite-* folders when looking for the latest run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ge-root-"));
    try {
      await mk(path.join(root, "20260101-000000-aaaa"));
      await mk(path.join(root, "suite-x"));
      expect(await findRun("/nowhere", undefined, { GRAPH_EXECUTION_RUNS_ROOT: root })).toBe(
        path.join(root, "20260101-000000-aaaa"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
