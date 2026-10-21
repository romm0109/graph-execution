import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { type Config, CONFIG_FILE, loadConfig } from "../config/config.js";
import { currentBranch, currentHead, isRepo, repoRoot } from "../git/git.js";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { loadTestPlan } from "../graph/testPlan.js";
import { executionLayers, validateGraph } from "../graph/validate.js";
import { getProvider } from "../providers/index.js";
import type { Provider } from "../providers/types.js";
import { findRun } from "../state/resume.js";
import { changedInputs, computeHashes, lockHolder, StateStore } from "../state/state.js";

export const RUNS_DIR = ".graph-execution";

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

  const branch = await currentBranch(repo);
  const startBranch = branch === "HEAD" ? undefined : branch;

  const config = await loadConfig(repo);
  const provider = opts.providerInstance ?? (await getProvider(opts.provider, repo));
  return { repo, startingCommit, ...(startBranch ? { startBranch } : {}), config, provider };
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
  providerInstance?: Provider;
}

export type PreflightResult =
  | { kind: "run"; tasks: Task[]; layers: Task[][]; env: Environment }
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

  const env = await checkEnvironment({ cwd: opts.cwd, provider: opts.provider, providerInstance: opts.providerInstance });
  return { kind: "run", tasks, layers, env };
}

async function preflightResume(opts: PreflightOptions): Promise<PreflightResult> {
  if (opts.tasksDir || opts.spec || opts.provider) {
    throw new UsageError("--resume takes no tasks folder, --spec or --provider: they come from the saved run");
  }
  const repo = await checkRepo(opts.cwd);
  const runDir = await findRun(repo, opts.runId);
  const store = await StateStore.load(path.join(runDir, "state.json"));
  const { state } = store;

  const current = await computeHashes(path.join(repo, CONFIG_FILE), state.tasksDir, state.specPath);
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

  const config = await loadConfig(repo);
  const provider = opts.providerInstance ?? (await getProvider(state.provider, repo));
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
