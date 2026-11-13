import { constants, existsSync, realpathSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
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
import { runInputs } from "../plan/paths.js";
import { RUNS_DIR, SANDBOX_ENV } from "../state/paths.js";
import { findRun } from "../state/resume.js";
import { z } from "zod";
import { changedInputs, computeHashes, lockHolder, type PlanRef, planRefSchema, StateStore } from "../state/state.js";

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

/** An input file must exist, be a readable file and be non-empty; `what` names it in the messages (`spec`, `content`). */
export async function checkInputFile(file: string, what: string): Promise<void> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new UsageError(`${what} file not found: ${file}`);
  }
  if (!info.isFile()) throw new UsageError(`${what} is not a file: ${file}`);
  try {
    await access(file, constants.R_OK);
  } catch {
    throw new UsageError(`${what} file is not readable: ${file}`);
  }
  if (info.size === 0) throw new UsageError(`${what} file is empty: ${file}`);
}

/** The spec must exist, be a readable file and be non-empty (PRD §7.11). */
export async function checkSpec(file: string): Promise<void> {
  await checkInputFile(file, "spec");
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
  const real = (p: string): string => (existsSync(p) ? realpathSync.native(p) : path.resolve(p));
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
  /** `--content <file>`: the planner writes the spec and the tasks. */
  content?: string;
  /** False when `--no-plan-gate` was given. */
  planGate?: boolean;
  /** `--refs <file>` (with `--content`): a JSON array `[{ ref, url?, title? }]`. */
  refs?: string;
  /** `--approve-plan` (with `--resume`): run the plan of a run waiting for approval. */
  approvePlan?: boolean;
  /** `--replan <file>` (with `--resume`): reject the plan with this feedback and plan again. */
  replan?: string;
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
      /** `--content`: the planner writes the spec and the tasks once the run exists. */
      kind: "plan";
      env: Environment;
      /** The refs read from `--refs`; `[]` without the option (the content is one unit). */
      refs: PlanRef[];
      reviewersFile?: string;
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
      /** `--approve-plan` on a run waiting for approval. */
      approvePlan?: true;
    }
  | {
      /** Plan again: `--replan` of a run waiting for approval, or a run killed while planning. */
      kind: "replan";
      repo: string;
      runDir: string;
      store: StateStore;
      config: Config;
      provider: Provider;
      /** The `--replan` file's text; none for a run killed while planning. */
      feedback?: string;
    };

/**
 * Every check that runs before a run is created or resumed, in the order the user meets them. It has no side
 * effects (no run id, no run directory, no exclude entry, no output), so the normal run, `--resume` and a detached
 * launcher cannot drift apart.
 */
export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  if (opts.resume) return preflightResume(opts);

  if (opts.approvePlan) throw new UsageError("--approve-plan can only be used with --resume");
  if (opts.replan !== undefined) throw new UsageError("--replan can only be used with --resume");
  if (opts.runId) throw new UsageError("--run can only be used with --resume");
  if (opts.content !== undefined) return preflightPlan(opts, opts.content);
  if (opts.refs !== undefined) throw new UsageError("--refs needs --content");
  if (opts.planGate === false) throw new UsageError("--no-plan-gate needs --content");
  if (!opts.tasksDir) throw new UsageError("missing required argument <tasks-dir>");
  if (!opts.spec) throw new UsageError("missing required option --spec <file>");
  if (!opts.provider) throw new UsageError("missing required option --provider <name>");
  await checkSpec(opts.spec);

  const tasks = await loadTasks(opts.tasksDir);
  validateGraph(tasks);
  await loadTestPlan(opts.tasksDir);
  const layers = executionLayers(tasks);
  const { env, reviewersFile, reviewers } = await checkRunEnvironment(opts, opts.provider);
  return { kind: "run", tasks, layers, env, ...(reviewersFile ? { reviewersFile } : {}), reviewers };
}

/** The checks of `--content`: no tasks folder or spec, a readable content file, then the same environment as a run. */
async function preflightPlan(opts: PreflightOptions, content: string): Promise<PreflightResult> {
  if (opts.tasksDir || opts.spec) throw new UsageError("--content cannot be used with a tasks folder or --spec: the planner writes them");
  if (!opts.provider) throw new UsageError("missing required option --provider <name>");
  await checkInputFile(content, "content");
  const refs = opts.refs !== undefined ? await readRefsFile(path.resolve(opts.cwd, opts.refs)) : [];
  const { env, reviewersFile, reviewers } = await checkRunEnvironment(opts, opts.provider);
  return { kind: "plan", env, refs, ...(reviewersFile ? { reviewersFile } : {}), reviewers };
}

/** Reads and checks a `--refs` file: a JSON array of `{ ref, url?, title? }` without duplicate refs. */
export async function readRefsFile(file: string): Promise<PlanRef[]> {
  let text: string;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`refs file not found: ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`refs file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = z.array(planRefSchema).safeParse(json);
  if (!parsed.success) throw new UsageError(`refs file ${file} is invalid: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  for (const { ref } of parsed.data) {
    if (seen.has(ref)) throw new UsageError(`refs file ${file} lists ${ref} twice`);
    seen.add(ref);
  }
  return parsed.data;
}

/** The reviewers file, git, config and provider checks shared by a run and a planned run. */
async function checkRunEnvironment(
  opts: PreflightOptions,
  provider: string,
): Promise<{ env: Environment; reviewersFile?: string; reviewers: Reviewer[] }> {
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

  const env = await checkEnvironment({ cwd: opts.cwd, provider, providerInstance: opts.providerInstance });
  // Validated here too, so `--web` refuses a bad combination before the hand-off.
  env.config = applyOverrides(env.config, opts.overrides);
  await checkReviewerProviders(reviewers, provider, env.repo);
  return { env, ...(reviewersFile ? { reviewersFile } : {}), reviewers };
}

async function preflightResume(opts: PreflightOptions): Promise<PreflightResult> {
  // The env var is ignored on resume: the reviewers come from the run's copy.
  if (opts.reviewers !== undefined) throw new UsageError("--resume takes no --reviewers: the reviewers come from the saved run");
  if (opts.tasksDir || opts.spec || opts.provider || opts.content !== undefined || opts.refs !== undefined) {
    throw new UsageError("--resume takes no tasks folder, --spec, --content, --refs or --provider: they come from the saved run");
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

  if (opts.approvePlan && opts.replan !== undefined) {
    throw new UsageError("--approve-plan and --replan cannot be used together");
  }
  const flag = opts.approvePlan ? "--approve-plan" : opts.replan !== undefined ? "--replan" : undefined;
  if (state.status === "awaiting-approval" && flag === undefined) {
    throw new UsageError(
      `run ${state.runId} waits for approval of its plan: resume it with --approve-plan to run it, or with --replan <file> to plan again with your feedback`,
    );
  }
  if (flag !== undefined && state.status !== "awaiting-approval") {
    throw new UsageError(`${flag}: run ${state.runId} is not waiting for approval (status ${state.status})`);
  }
  if (state.status === "needs-info") {
    throw new UsageError(
      `cannot resume run ${state.runId}: it needs more information (needs-info is final); start a new run with --content once the questions are answered`,
    );
  }
  // A run killed (`planning`) or interrupted (`aborted`, no plan yet) while planning plans again from the start.
  const killedPlanning = state.plan !== undefined && (state.status === "planning" || (state.status === "aborted" && !state.hashes));
  if (opts.replan !== undefined || killedPlanning) {
    let feedback: string | undefined;
    if (opts.replan !== undefined) {
      const file = path.resolve(opts.cwd, opts.replan);
      await checkInputFile(file, "feedback");
      feedback = (await readFile(file, "utf8")).trim();
    }
    const config = applyOverrides(await loadConfig(repo), state.overrides);
    const provider = opts.providerInstance ?? (await getProvider(state.provider, repo));
    await checkReviewerProviders(await readRunReviewers(runDir), state.provider, repo);
    return { kind: "replan", repo, runDir, store, config, provider, ...(feedback !== undefined ? { feedback } : {}) };
  }
  if (state.status === "planning") throw new UsageError(`cannot resume run ${state.runId}: it is still planning`);
  if (!state.hashes || (!state.plan?.name && (state.specPath === undefined || state.tasksDir === undefined))) {
    if (state.plan) {
      throw new UsageError(
        `cannot resume run ${state.runId}: planning did not finish${state.plan.error ? ` (${state.plan.error})` : ""}; start a new run with --content`,
      );
    }
    throw new UsageError(`cannot resume run ${state.runId}: it is still planning`);
  }

  const inputs = runInputs(state, runDir);
  const current = await computeHashes(path.join(repo, CONFIG_FILE), inputs.tasksDir, inputs.specPath, path.join(runDir, RUN_REVIEWERS_FILE));
  const changed = changedInputs(state.hashes, current);
  if (changed.length > 0) {
    throw new Error(
      `cannot resume run ${state.runId}: the ${changed.join(", the ")} changed since the run started ` +
        `(spec ${inputs.specPath}, tasks ${inputs.tasksDir}, config ${path.join(repo, CONFIG_FILE)})`,
    );
  }
  const tasks = await loadTasks(inputs.tasksDir);
  validateGraph(tasks);
  await loadTestPlan(inputs.tasksDir);

  const config = applyOverrides(await loadConfig(repo), state.overrides);
  const provider = opts.providerInstance ?? (await getProvider(state.provider, repo));
  await checkReviewerProviders(await readRunReviewers(runDir), state.provider, repo);
  return { kind: "resume", repo, runDir, store, tasks, config, provider, ...(opts.approvePlan ? { approvePlan: true as const } : {}) };
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
