import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { CONFIG_FILE } from "../config/config.js";
import { FAKE_PID_FILE } from "../providers/fake.js";
import { applyResolutionOffline } from "../escalation/resolve.js";
import { findRun, reconcile } from "./resume.js";
import { LOCK_FILE } from "./state.js";
import { start, resumeCli, cliRun, onlyRun, readState, readCalls, withRepo } from "../__fixtures__/resume.js";

describe("resume", () => {
  it("refuses to resume a run that already finished, and changes nothing", () =>
    withRepo(undefined, {}, async (repo) => {
      expect((await start(repo)).exitCode).toBe(0);
      const { runDir } = await onlyRun(repo);
      const status = await gitOut(repo.dir, ["status", "--porcelain"]);
      const saved = await readFile(path.join(runDir, "state.json"), "utf8");
      await rm(repo.calls, { force: true });
      const res = await resumeCli(repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("already finished");
      expect(res.stdout).not.toContain("applying");
      expect(await readCalls(repo)).toEqual([]);
      expect(await gitOut(repo.dir, ["status", "--porcelain"])).toBe(status);
      expect(await readFile(path.join(runDir, "state.json"), "utf8")).toBe(saved);
      expect((await readState(runDir)).status).toBe("applied");
      expect(existsSync(path.join(runDir, LOCK_FILE))).toBe(false);
    }));

  it("resumes a run whose apply failed and only applies it", () =>
    withRepo(undefined, {}, async (repo) => {
      await writeFile(path.join(repo.dir, "2.txt"), "mine\n");
      const first = await start(repo);
      expect(first.exitCode, first.stdout).toBe(2);
      const { runDir } = await onlyRun(repo);
      expect((await readState(runDir)).status).toBe("failed");

      await rm(path.join(repo.dir, "2.txt"));
      await rm(repo.calls, { force: true });
      const res = await resumeCli(repo);
      expect(res.exitCode, res.stdout).toBe(0);
      expect((await readState(runDir)).status).toBe("applied");
      const calls = await readCalls(repo);
      expect(calls.filter((c) => /^(task|reviewer|tester):/.test(c))).toEqual([]);
      expect((await gitOut(repo.dir, ["status", "--porcelain"])).split("\n").sort()).toEqual([
        "?? 1.txt",
        "?? 2.txt",
        "?? 3.txt",
        "?? 4.txt",
      ]);
    }));


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

  // Windows has no SIGINT one process can send another: child.kill("SIGINT") terminates it without running handlers.
  it.skipIf(process.platform === "win32")("keeps the attempt counter of a task interrupted while running", () =>
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

  it.skipIf(process.platform === "win32")("keeps an open escalation through Ctrl+C and returns to its wait on --resume", () =>
    withRepo(
      undefined,
      { "task:2": { attempts: [{ escalate: { reason: "r", evidence: "e", questions: [{ id: "q1", question: "A or B?" }] } }] } },
      async (repo) => {
        const child = start(repo);
        let out = "";
        child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
        const runsDir = path.join(repo.dir, ".graph-execution");
        const escalated = async (): Promise<string | undefined> => {
          const runIds = await readdir(runsDir).catch(() => []);
          const file = runIds[0] && path.join(runsDir, runIds[0], "state.json");
          if (!file || !existsSync(file)) return undefined;
          try {
            const state = JSON.parse(await readFile(file, "utf8")) as { tasks: Record<string, { status: string }> };
            return state.tasks["2"]?.status === "escalated" && state.tasks["3"]?.status === "merged" ? runIds[0] : undefined;
          } catch {
            return undefined;
          }
        };
        while (!(await escalated()) || !out.includes("waiting for your decision")) await new Promise((r) => setTimeout(r, 50));
        expect(out).toMatch(/waiting for your decision on E1 \(task 2\): http:\/\/127\.0\.0\.1:\d+\//);
        expect(out).not.toContain("web view:");
        const { runDir } = await onlyRun(repo);
        expect(existsSync(path.join(runDir, "web.json"))).toBe(true);
        child.kill("SIGINT");
        expect((await child).exitCode).toBe(2);
        expect(existsSync(path.join(runDir, "web.json"))).toBe(false);
        const stopped = await readState(runDir);
        expect(stopped.tasks["2"]!.status).toBe("escalated");
        expect(stopped.escalations).toEqual([{ id: "E1", node: "2", status: "open" }]);

        // --resume goes back to the same wait: task 2 is not rerun and task 4 does not start.
        await rm(repo.calls, { force: true });
        const again = cliRun(repo, ["--resume"]);
        let out2 = "";
        again.stdout?.on("data", (c: Buffer) => (out2 += c.toString()));
        while (!out2.includes("waiting for your decision on E1 (task 2)")) await new Promise((r) => setTimeout(r, 50));
        const resumed = await readState(runDir);
        expect(resumed.tasks["2"]!.status).toBe("escalated");
        expect(resumed.escalations).toEqual([{ id: "E1", node: "2", status: "open" }]);
        expect(resumed.status).toBe("running");
        again.kill("SIGINT");
        expect((await again).exitCode).toBe(2);
        expect((await readCalls(repo)).filter((c) => c.startsWith("task:"))).toEqual([]);
        expect((await readState(runDir)).tasks["2"]!.status).toBe("escalated");
      },
    ));

  it.skipIf(process.platform === "win32")("resumes from the run's own task copy after an offline resolution added a task", () =>
    withRepo(
      undefined,
      { "task:2": { attempts: [{ escalate: { reason: "r", evidence: "e", questions: [{ id: "q1", question: "A or B?" }] } }] } },
      async (repo) => {
        const child = start(repo);
        let out = "";
        child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
        while (!out.includes("waiting for your decision on E1")) await new Promise((r) => setTimeout(r, 50));
        const { runDir } = await onlyRun(repo);
        while ((await readState(runDir)).tasks["3"]!.status !== "merged") await new Promise((r) => setTimeout(r, 50));
        child.kill("SIGINT");
        expect((await child).exitCode).toBe(2);

        const applied = await applyResolutionOffline(runDir, {
          escalationIds: ["E1"],
          action: "change",
          guidance: "Use B.",
          addTasks: [{ id: "5", content: "Document the result.", dependencies: ["4"] }],
        });
        expect(applied.requeued).toEqual(["2"]);
        const stopped = await readState(runDir);
        expect(stopped.tasksSource).toBe("run");
        expect(stopped.tasks["2"]).toEqual({ status: "pending", attempts: 0 });
        expect(stopped.tasks["5"]).toEqual({ status: "pending", attempts: 0 });

        await writeFile(repo.script, JSON.stringify({}));
        await rm(repo.calls, { force: true });
        const res = await resumeCli(repo);
        expect(res.exitCode, `${res.stdout}\n${res.stderr}`).toBe(0);
        expect(res.stderr).not.toContain("changed since the run started");
        const calls = (await readCalls(repo)).filter((c) => c.startsWith("task:"));
        expect(calls.sort()).toEqual(["task:2", "task:4", "task:5"]);
        const done = await readState(runDir);
        expect(done.tasks["5"]!.status).toBe("merged");
        expect(["applied", "done"]).toContain(done.status);
      },
    ));

  it("refuses a worktree of the run's branch outside the run folder, keeps its own, and resumes after cleanup", () =>
    withRepo(undefined, { "task:1": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }] } }, async (repo) => {
      expect((await start(repo)).exitCode).toBe(2);
      const { runId, runDir } = await onlyRun(repo);
      const outside = await mkdtemp(path.join(tmpdir(), "leftover-"));
      await rm(outside, { recursive: true });
      try {
        await execa("git", ["worktree", "add", "-q", "-b", `graph-task/${runId}/2`, outside], { cwd: repo.dir });
        const refused = await resumeCli(repo);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr).toContain("cannot start");
        expect(refused.stderr).toContain(realpathSync(outside));
        expect((await readState(runDir)).tasks["1"]).toMatchObject({ status: "failed" });

        await execa("git", ["worktree", "remove", "--force", outside], { cwd: repo.dir });
        await execa("git", ["branch", "-D", `graph-task/${runId}/2`], { cwd: repo.dir });
        await writeFile(repo.script, "{}");
        const res = await resumeCli(repo);
        expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
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

      // A fresh run has no resume markers (KAN-97).
      expect(state.resumedAt).toBeUndefined();
      expect(Object.values(state.tasks).some((t) => t.resumed !== undefined)).toBe(false);
      expect(state.reportsResumed).toBeUndefined();

      const repaired = await reconcile(structuredClone(state), repo.dir);
      expect(repaired.tasks["4"]).toMatchObject({ status: "pending", attempts: 0, branch: state.tasks["4"]!.branch, resumed: "reran" });
      for (const id of ["1", "2", "3"]) expect(repaired.tasks[id]).toEqual({ ...state.tasks[id], resumed: "reused" });
      expect(repaired.resumedAt).toEqual(expect.any(String));

      // The reviews were of a tree that no longer exists: the review phase starts over.
      expect(repaired.review).toEqual({ phase: "validate", round: 0, validationRounds: 0, reports: {}, humanRound: 0, budgetBase: 0 });
      expect(existsSync(path.join(runDir, "reports"))).toBe(false);

      // The run had finished (applied); made resumable again, and not re-applied over the first apply's files.
      await writeFile(path.join(runDir, "state.json"), JSON.stringify({ ...state, status: "aborted" }, null, 2));
      await rm(repo.calls, { force: true });
      const res = await resumeCli(repo, ["--no-merge"]);
      expect(res.exitCode, res.stdout).toBe(0);
      const calls = await readCalls(repo);
      expect(calls.filter((c) => c.startsWith("task:"))).toEqual(["task:4"]);
      expect(calls).toContain("reviewer:code-r0");
      expect((await gitOut(repo.dir, ["ls-tree", "--name-only", `graph/${runId}`])).split("\n")).toContain("4.txt");
      // The markers are saved with the run (KAN-97): kept tasks reused, the redone one and the new reviews ran again.
      const after = await readState(runDir);
      expect(Object.fromEntries(Object.entries(after.tasks).map(([id, t]) => [id, t.resumed]))).toEqual({ "1": "reused", "2": "reused", "3": "reused", "4": "reran" });
      expect(after.reportsResumed?.code).toBe("reran");
    }));

  it("keeps an escalated task escalated, with its branch and attempts", () =>
    withRepo(undefined, {}, async (repo) => {
      expect((await start(repo)).exitCode).toBe(0);
      const { runDir } = await onlyRun(repo);
      const state = await readState(runDir);
      const branch = state.tasks["2"]!.branch!;
      // A finished run deletes its task branches; task 2's is put back, as an escalated task keeps it.
      await execa("git", ["branch", branch, `${state.tasks["2"]!.mergeCommit!}^2`], { cwd: repo.dir });
      const escalated = structuredClone(state);
      Object.assign(escalated.tasks["2"]!, { status: "escalated", attempts: 2 });
      delete escalated.tasks["2"]!.mergeCommit;
      const repaired = await reconcile(escalated, repo.dir);
      expect(repaired.tasks["2"]).toMatchObject({ status: "escalated", attempts: 2, branch });
      expect(repaired.tasks["2"]!.resumed).toBeUndefined();
      expect(await gitOut(repo.dir, ["branch", "--list", branch])).toContain(branch);
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
      expect(repaired.tasks["2"]).toEqual({ status: "merged", attempts: 1, branch: state.tasks["2"]!.branch, mergeCommit, baseSha: state.tasks["2"]!.baseSha, resumed: "reused" });
      expect(repaired.tasks["3"]).toMatchObject({ status: "pending", attempts: 1, resumed: "reran" });
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
