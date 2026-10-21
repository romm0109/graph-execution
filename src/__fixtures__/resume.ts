import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect } from "vitest";
import { gitOut, tempRepo } from "./repo.js";
import { CONFIG_FILE } from "../config/config.js";
import { FAKE_LOG_ENV, FAKE_SCRIPT_ENV } from "../providers/fake.js";
import { KILL_AT_ENV, LOCK_FILE, type RunState, stateSchema } from "../state/state.js";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const cli = path.join(root, "dist", "cli.js");
export const diamond = path.join(root, "src", "__fixtures__", "diamond");
export const fixtureSpec = path.join(root, "src", "__fixtures__", "spec.md");

export const blocker = {
  id: "F1",
  severity: "blocker",
  file: "1.txt",
  description: "Wrong content.",
  failureScenario: "Reading 1.txt returns the task id instead of the result.",
  status: "open",
};

/** The diamond with a validation gate, one blocker in round 0, one fix pass and a clean re-review. */
export const FULL_FLOW = {
  config: { validate: ['node -e "process.exit(0)"'] },
  script: { "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] } },
};

export interface Repo {
  dir: string;
  spec: string;
  script: string;
  calls: string;
}

export async function setupRepo(config: unknown, script: unknown): Promise<Repo> {
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

export const cliRun = (repo: Repo, args: string[], env: Record<string, string> = {}) =>
  execa("node", [cli, ...args], {
    cwd: repo.dir,
    env: { [FAKE_SCRIPT_ENV]: repo.script, [FAKE_LOG_ENV]: repo.calls, ...env },
    reject: false,
  });

export const start = (repo: Repo, env: Record<string, string> = {}) =>
  cliRun(repo, [diamond, "--spec", repo.spec, "--provider", "fake"], env);

export const resumeCli = (repo: Repo, args: string[] = []) => cliRun(repo, ["--resume", ...args]);

export async function onlyRun(repo: Repo): Promise<{ runId: string; runDir: string }> {
  const runs = await readdir(path.join(repo.dir, ".graph-execution"));
  expect(runs).toHaveLength(1);
  return { runId: runs[0]!, runDir: path.join(repo.dir, ".graph-execution", runs[0]!) };
}

export const readState = async (runDir: string): Promise<RunState> =>
  stateSchema.parse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));

export const readCalls = async (repo: Repo): Promise<string[]> =>
  existsSync(repo.calls) ? (await readFile(repo.calls, "utf8")).split("\n").filter(Boolean) : [];

export const tree = (repo: Repo, runId: string): Promise<string> => gitOut(repo.dir, ["rev-parse", `graph/${runId}^{tree}`]);

export async function withRepo<T>(config: unknown, script: unknown, fn: (repo: Repo) => Promise<T>): Promise<T> {
  const repo = await setupRepo(config, script);
  try {
    return await fn(repo);
  } finally {
    await rm(repo.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Kills the run hard after the n-th state save, resumes it and checks the outcome; false once n is past the end. */
export async function killAndResume(n: number, expectedTree: string): Promise<boolean> {
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
    // A kill after the result was applied (the final status save) makes the resume's apply conflict and get summarized.
    if (review.phase === "done") {
      expect(calls.filter((c) => !c.startsWith("task:") && !c.startsWith("summarizer:"))).toEqual([]);
    }

    const after = await readState(runDir);
    expect(after.review.phase).toBe("done");
    expect(Object.values(after.tasks).map((t) => t.status)).toEqual(["merged", "merged", "merged", "merged"]);
    expect(existsSync(path.join(runDir, LOCK_FILE))).toBe(false);
    return true;
  });
}
