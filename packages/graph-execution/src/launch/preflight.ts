import { constants, existsSync, realpathSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import {
  applyOverrides,
  type Config,
  CONFIG_FILE,
  type ConfigOverrides,
  definedOverrides,
  loadConfig,
  OVERRIDE_FLAGS,
} from "../config/config.js";
import { currentBranch, currentHead, gitIdentityProblem, isRepo, listWorktrees, repoRoot } from "../git/git.js";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { loadTestPlan } from "../graph/testPlan.js";
import { executionLayers, validateGraph } from "../graph/validate.js";
import { getProvider } from "../providers/index.js";
import type { Provider } from "../providers/types.js";
import { BUILTIN_REVIEWERS, enabledReviewers, loadReviewersFile, type Reviewer, ReviewersError, readRunReviewers, reviewersFileOf, RUN_REVIEWERS_FILE } from "../review/reviewers.js";
import { RUNS_DIR, SANDBOX_ENV } from "../state/paths.js";
import { findRun } from "../state/resume.js";
import { changedInputs, computeHashes, lockHolder, StateStore } from "../state/state.js";

export { RUNS_DIR };

/** A mistake in the command-line arguments. */
export class UsageError extends Error {}

/**
 * Refuses a run in a repository inside a `.graph-execution` folder: that is one of a run's worktrees, so an agent
 * started graph-execution itself. A nested run doubles the path length (deep enough to break git on Windows) and
 * starts a whole second set of agents.
 */
export function assertNotNested(repo: string): void {
  if (repo.split(/[\\/]/).includes(RUNS_DIR)) {
    throw new Error(
      `refusing to run inside a graph-execution worktree (${repo}): graph-execution cannot be started by its own agents`,
    );
  }
}

/** The spec must exist, be a readable file and be non-empty (PRD §7.11). */
export async function checkSpec(file: string): Promise<void> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new UsageError(`spec file not found: ${file}`);
  }
  if (!info.isFile()) throw new UsageError(`spec is not a file: ${file}`);
  try {
    await access(file, constants.R_OK);
  } catch {
    throw new UsageError(`spec file is not readable: ${file}`);
  }
  if (info.size === 0) throw new UsageError(`spec file is empty: ${file}`);
}

export interface Environment {
  repo: string;
  startingCommit: string;
  /** The branch checked out; undefined on a detached HEAD. */
  startBranch?: string;
  config: Config;
  provider: Provider;
}

export interface EnvironmentOptions {
  cwd: string;
  provider: string;
  /** Overrides provider lookup (tests inject a fake provider instance). */
  providerInstance?: Provider;
}

/** The git, config and provider checks of a run. Creates nothing and prints nothing. */
export async function checkEnvironment(opts: EnvironmentOptions): Promise<Environment> {
  const repo = await checkRepo(opts.cwd);

  let startingCommit: string;
  try {
    startingCommit = await currentHead(repo);
  } catch {
    throw new Error("the repository has no commits yet; commit something before running");
  }
  await assertGitIdentity(repo);

  const branch = await currentBranch(repo);
  const startBranch = branch === "HEAD" ? undefined : branch;

  const config = await loadConfig(repo);
  const provider = opts.providerInstance ?? (await getProvider(opts.provider, repo));
  return { repo, startingCommit, ...(startBranch ? { startBranch } : {}), config, provider };
}

/**
 * Checks the provider of every reviewer that names one other than the run's, so a missing CLI fails at startup
 * (exit 2) instead of in the review round.
 */
export async function checkReviewerProviders(reviewers: readonly Reviewer[], runProvider: string, repo: string): Promise<void> {
  const seen = new Set<string>([runProvider]);
  for (const r of reviewers) {
    if (!r.provider || seen.has(r.provider)) continue;
    seen.add(r.provider);
    try {
      await getProvider(r.provider, repo);
    } catch (err) {
      throw new UsageError(`reviewer "${r.id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Refuses a repository where git has no author or committer identity: every agent's commit would fail. */
export async function assertGitIdentity(repo: string): Promise<void> {
  const problem = await gitIdentityProblem(repo);
  if (problem === undefined) return;
  throw new Error(
    `git has no commit identity, so no agent could commit (${problem}). Set one, then run again:\n` +
      `  git config --global user.name "Your Name"\n` +
      `  git config --global user.email "you@example.com"\n` +
      `(drop --global to set it for this repository only, or set GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, ` +
      `GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL)`,
  );
}

/**
 * Refuses a run whose branches (`graph/<runId>`, `graph-task/<runId>/*`) are checked out in a worktree: git would
 * refuse to check them out again. Such a worktree may hold someone's uncommitted work, so it is never removed here;
 * the message lists the cleanup commands. Worktrees whose directory is gone are skipped (`git worktree prune`
 * reclaims them), and so are those inside `ownWorktreesDir` (a resumed run's own worktrees).
 */
export async function assertNoLeftoverWorktrees(repo: string, runId: string, ownWorktreesDir?: string): Promise<void> {
  const real = (p: string): string => (existsSync(p) ? realpathSync(p) : path.resolve(p));
  const own = ownWorktreesDir === undefined ? undefined : real(ownWorktreesDir);
  const inside = (p: string): boolean => {
    if (own === undefined) return false;
    const rel = path.relative(own, real(p));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const leftovers = (await listWorktrees(repo)).filter(
    (w): w is typeof w & { branch: string } =>
      w.branch !== undefined &&
      (w.branch === `graph/${runId}` || w.branch.startsWith(`graph-task/${runId}/`)) &&
      !w.prunable &&
      !inside(w.path),
  );
  if (leftovers.length === 0) return;
  throw new Error(
    `run ${runId} cannot start: its branches are still checked out in leftover worktrees:\n` +
      leftovers.map((w) => `  ${w.path} (${w.branch})\n`).join("") +
      `Remove them (this deletes any uncommitted changes in them), then run again:\n` +
      leftovers.map((w) => `  git worktree remove --force ${w.path}\n  git branch -D ${w.branch}`).join("\n"),
  );
}

async function checkRepo(cwd: string): Promise<string> {
  if (!(await isRepo(cwd))) throw new Error(`not inside a git repository: ${cwd}`);
  const repo = await repoRoot(cwd);
  assertNotNested(repo);
  return repo;
}

export interface PreflightOptions {
  cwd: string;
  tasksDir?: string;
  spec?: string;
  provider?: string;
  resume?: boolean;
  runId?: string;
  merge?: boolean;
  humanReview?: boolean;
  /** Config keys overridden by run flags; refused on `--resume`. */
  overrides?: ConfigOverrides;
  providerInstance?: Provider;
  /** `--reviewers <file>`; the env var is read here too. */
  reviewers?: string;
  /** Where `GRAPH_EXECUTION_REVIEWERS` is read; `process.env` when omitted. */
  env?: NodeJS.ProcessEnv;
}

export type PreflightResult =
  | {
      kind: "run";
      tasks: Task[];
      layers: Task[][];
      env: Environment;
      /** The absolute path of the validated reviewers file, when the run has one. */
      reviewersFile?: string;
      /** The run's enabled reviewers; the built-ins without a reviewers file. */
      reviewers: Reviewer[];
    }
  | {
      kind: "resume";
      repo: string;
      runDir: string;
      store: StateStore;
      tasks: Task[];
      config: Config;
      provider: Provider;
    };

/**
 * Every check that runs before a run is created or resumed, in the order the user meets them. It has no side
 * effects (no run id, no run directory, no exclude entry, no output), so the normal run, `--resume` and a detached
 * launcher cannot drift apart.
 */
export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  if (opts.resume) return preflightResume(opts);

  if (opts.runId) throw new UsageError("--run can only be used with --resume");
  if (!opts.tasksDir) throw new UsageError("missing required argument <tasks-dir>");
  if (!opts.spec) throw new UsageError("missing required option --spec <file>");
  if (!opts.provider) throw new UsageError("missing required option --provider <name>");
  await checkSpec(opts.spec);

  const tasks = await loadTasks(opts.tasksDir);
  validateGraph(tasks);
  await loadTestPlan(opts.tasksDir);
  const layers = executionLayers(tasks);
  const file = reviewersFileOf(opts.reviewers, opts.env ?? process.env);
  let reviewersFile: string | undefined;
  let reviewers: Reviewer[] = [...BUILTIN_REVIEWERS];
  if (file !== undefined) {
    reviewersFile = path.resolve(opts.cwd, file);
    try {
      reviewers = enabledReviewers(await loadReviewersFile(reviewersFile));
    } catch (err) {
      if (err instanceof ReviewersError) throw new UsageError(err.message);
      throw err;
    }
  }

  const env = await checkEnvironment({ cwd: opts.cwd, provider: opts.provider, providerInstance: opts.providerInstance });
  // Validated here too, so `--web` refuses a bad combination before the hand-off.
  env.config = applyOverrides(env.config, opts.overrides);
  await checkReviewerProviders(reviewers, opts.provider, env.repo);
  return { kind: "run", tasks, layers, env, ...(reviewersFile ? { reviewersFile } : {}), reviewers };
}

async function preflightResume(opts: PreflightOptions): Promise<PreflightResult> {
  // The env var is ignored on resume: the reviewers come from the run's copy.
  if (opts.reviewers !== undefined) throw new UsageError("--resume takes no --reviewers: the reviewers come from the saved run");
  if (opts.tasksDir || opts.spec || opts.provider) {
    throw new UsageError("--resume takes no tasks folder, --spec or --provider: they come from the saved run");
  }
  if (opts.humanReview !== undefined) {
    throw new UsageError("--resume takes no --human-review or --no-human-review: the setting comes from the saved run");
  }
  const given = Object.entries(definedOverrides(opts.overrides))[0];
  if (given) {
    const [key, value] = given as [keyof ConfigOverrides, unknown];
    const flag = key === "validateParallel" && value === false ? "--no-validate-parallel" : OVERRIDE_FLAGS[key];
    throw new UsageError(`cannot change ${flag} on --resume: the run keeps the options it started with`);
  }
  const repo = await checkRepo(opts.cwd);
  await assertGitIdentity(repo);
  const runDir = await findRun(repo, opts.runId);
  const store = await StateStore.load(path.join(runDir, "state.json"));
  const { state } = store;
  if (state.sandbox && process.env[SANDBOX_ENV] !== "1") {
    throw new UsageError(
      `run ${state.runId} ran in a sandbox: resume it from graph-manager, or with graph-execution --resume --run ${state.runId} --sandbox in a graph-manager terminal`,
    );
  }
  await assertNoLeftoverWorktrees(repo, state.runId, path.join(runDir, "worktrees"));
  if (state.status === "applied" || state.status === "done") {
    throw new UsageError(
      `cannot resume run ${state.runId}: it already finished (${state.status}); the result is on ${state.integrationBranch}`,
    );
  }

  const current = await computeHashes(path.join(repo, CONFIG_FILE), state.tasksDir, state.specPath, path.join(runDir, RUN_REVIEWERS_FILE));
  const changed = changedInputs(state.hashes, current);
  if (changed.length > 0) {
    throw new Error(
      `cannot resume run ${state.runId}: the ${changed.join(", the ")} changed since the run started ` +
        `(spec ${state.specPath}, tasks ${state.tasksDir}, config ${path.join(repo, CONFIG_FILE)})`,
    );
  }
  const tasks = await loadTasks(state.tasksDir);
  validateGraph(tasks);
  await loadTestPlan(state.tasksDir);

  const config = applyOverrides(await loadConfig(repo), state.overrides);
  const provider = opts.providerInstance ?? (await getProvider(state.provider, repo));
  await checkReviewerProviders(await readRunReviewers(runDir), state.provider, repo);
  return { kind: "resume", repo, runDir, store, tasks, config, provider };
}

/**
 * Refuses a run whose lock is held by another live process. Only the detached launcher calls this: the run process
 * itself takes the lock with `acquireLock`.
 */
export async function assertNotRunning(runDir: string): Promise<void> {
  const pid = await lockHolder(runDir);
  if (pid !== undefined) {
    throw new Error(
      `run ${path.basename(runDir)} is already running (PID ${pid}); open it with \`graph-execution open\``,
    );
  }
}
