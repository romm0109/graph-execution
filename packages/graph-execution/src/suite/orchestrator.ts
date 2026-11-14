import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkProjectSuite } from "../cleanup/links.js";
import { loadConfig } from "../config/config.js";
import {
  applyToCheckout,
  createBranch,
  currentBranch,
  ensureExcluded,
  isDirty,
  isRepo,
  removeWorktreeIfPresent,
  repoRoot,
  resolveRef,
} from "../git/git.js";
import { assertGitIdentity, checkReviewerProviders, preflight, UsageError } from "../launch/preflight.js";
import {
  enabledReviewers,
  loadReviewersFile,
  readRunReviewers,
  reviewersFileOf,
  ReviewersError,
  RUN_REVIEWERS_FILE,
} from "../review/reviewers.js";
import { DEFAULT_CONCURRENCY } from "../runner/run.js";
import { generateRunId } from "../runner/startup.js";
import { EXIT_ABORT, EXIT_REVIEW_FAILED, EXIT_SUCCESS, type ExitCode, AbortRunError, InterruptedError } from "../state/errors.js";
import { RUN_ID_ENV, RUN_ID_PATTERN, RUNS_DIR, RUNS_ROOT_ENV, SANDBOX_ENV, SANDBOX_IMAGE_ENV } from "../state/paths.js";
import { acquireLock, stateSchema } from "../state/state.js";
import { reapOrphans } from "../state/processes.js";
import { SuiteControl } from "./control.js";
import { RetryHub } from "../runner/retry-hub.js";
import { RunEmitter } from "../runner/events.js";
import { createSuiteServer, type SuiteServer } from "./server.js";
import { announceReady, appendRunLog, webJsonPath } from "../web/serve.js";
import { listenFromEnv } from "../web/start.js";
import { codeReviewSkipped } from "../review/phase.js";
import { integrationWorktreeOf, readRunState, runE2e, suiteBranchOf } from "./e2e.js";
import { integrate } from "./integrate.js";
import { jointPhase, removeJointWorktrees } from "./joint.js";
import { loadProject, type Project } from "./project.js";
import { initialShares } from "./shares.js";
import { defaultSpawn, featureArgs, type FeatureProcess, type SpawnFeature } from "./spawn.js";
import { featureRunDir, SUITE_FILE, type SuiteFeature, type SuiteRepo, suiteStateSchema, SuiteStore, suiteDirOf } from "./state.js";

export interface SuiteOptions {
  cwd: string;
  features: { tasksDir: string; prd: string }[];
  /** `--project <dir>`: a multi-repo suite on that project folder (relative to `cwd`); `features` is then empty. */
  project?: string;
  provider: string;
  model?: string;
  concurrency?: number;
  merge: boolean;
  /** `--human-review` / `--no-human-review`; undefined lets the config decide. */
  humanReview?: boolean;
  /** `--reviewers <file>`: the reviewers of the feature runs and the e2e phase. */
  reviewers?: string;
  /** Where `GRAPH_EXECUTION_REVIEWERS` is read; `process.env` when omitted. */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFeature;
  /** The built CLI the children run; defaults to the `cli.js` next to the compiled `suite/` folder. */
  cliPath?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Lets an outside driver retry a failed feature or start the integration while the suite runs. */
  control?: SuiteControl;
  /** The web view's human review: the hub answers the wait, the emitter reports it. */
  reviewHub?: RetryHub;
  reviewEvents?: RunEmitter;
  /** Called once the suite folder, its `suite.json` and the lock exist. */
  onReady?: (suiteDir: string) => void | Promise<void>;
}

export interface ResumeSuiteOptions {
  cwd: string;
  /** Defaults to the latest `suite-*` folder with a `suite.json`. */
  suiteId?: string;
  control?: SuiteControl;
  reviewHub?: RetryHub;
  reviewEvents?: RunEmitter;
  spawn?: SpawnFeature;
  cliPath?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
  onReady?: (suiteDir: string) => void | Promise<void>;
}

interface SuiteContext {
  suiteId: string;
  suiteDir: string;
  store: SuiteStore;
  log: (line: string) => void;
  spawn: SpawnFeature;
  release: () => Promise<void>;
  /** The suite's home: the repo, or the project folder of a multi-repo suite. */
  repo: string;
  /** Set for a multi-repo suite. */
  project?: Project;
}

type DriveOptions = Pick<SuiteOptions, "control" | "signal" | "reviewHub" | "reviewEvents">;

function uniqueNames(dirs: string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    const base = path.basename(dir).replace(/[^A-Za-z0-9_-]/g, "-") || "feature";
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  });
}

async function featureDone(runDir: string): Promise<boolean> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));
    return parsed.success && parsed.data.status === "done";
  } catch {
    return false;
  }
}

async function findSuite(repo: string, suiteId?: string): Promise<string> {
  const root = path.join(repo, RUNS_DIR);
  if (suiteId !== undefined) {
    const dir = suiteDirOf(repo, suiteId);
    if (!existsSync(path.join(dir, SUITE_FILE))) throw new Error(`no suite ${suiteId} to resume in ${root}`);
    return dir;
  }
  const ids = (await readdir(root).catch(() => []))
    .filter((id) => id.startsWith("suite-") && existsSync(path.join(root, id, SUITE_FILE)))
    .sort();
  if (ids.length === 0) throw new Error(`no suite to resume in ${root}`);
  return path.join(root, ids.at(-1)!);
}

const defaultSpawnOf = (cliPath: string | undefined, repo: string): SpawnFeature =>
  defaultSpawn(cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url)), repo);

export async function runSuite(opts: SuiteOptions): Promise<ExitCode> {
  const ctx = await startSuite(opts);
  try {
    return await driveFeatures(ctx, opts);
  } finally {
    await ctx.release();
  }
}

/**
 * The validated reviewers file of a new suite (`--reviewers`, else a non-empty `GRAPH_EXECUTION_REVIEWERS`) as an
 * absolute path; undefined without one.
 */
async function suiteReviewersFile(cwd: string, flag: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const named = reviewersFileOf(flag, env);
  if (named === undefined) return undefined;
  const file = path.resolve(cwd, named);
  try {
    await loadReviewersFile(file);
  } catch (err) {
    if (err instanceof ReviewersError) throw new UsageError(err.message);
    throw err;
  }
  return file;
}

/**
 * The checks that need no suite folder: at least 2 features, distinct folders, the reviewers file, the preflight
 * of each.
 */
export async function validateSuite(
  opts: Pick<SuiteOptions, "cwd" | "features" | "provider" | "reviewers" | "env">,
): Promise<{ features: { tasksDir: string; prd: string }[]; names: string[]; reviewersFile?: string }> {
  if (opts.features.length < 2) throw new UsageError("a suite needs at least 2 --feature");
  const features = opts.features.map((f) => ({
    tasksDir: path.resolve(opts.cwd, f.tasksDir),
    prd: path.resolve(opts.cwd, f.prd),
  }));
  const names = uniqueNames(features.map((f) => f.tasksDir));
  if (new Set(features.map((f) => f.tasksDir)).size !== features.length) {
    throw new UsageError("two features use the same tasks folder");
  }
  // Once for the whole suite, so the message carries no feature name.
  if (await isRepo(opts.cwd)) await assertGitIdentity(opts.cwd);
  const reviewersFile = await suiteReviewersFile(opts.cwd, opts.reviewers, opts.env ?? process.env);
  if (reviewersFile && (await isRepo(opts.cwd))) {
    await checkReviewerProviders(enabledReviewers(await loadReviewersFile(reviewersFile)), opts.provider, await repoRoot(opts.cwd));
  }
  for (const [i, f] of features.entries()) {
    try {
      // The file is passed explicitly, and the env emptied, so each feature is checked with the suite's reviewers only.
      await preflight({
        cwd: opts.cwd,
        tasksDir: f.tasksDir,
        spec: f.prd,
        provider: opts.provider,
        ...(reviewersFile ? { reviewers: reviewersFile } : {}),
        env: {},
      });
    } catch (err) {
      throw new Error(`${names[i]}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return { features, names, ...(reviewersFile ? { reviewersFile } : {}) };
}

/**
 * The id of a new suite: `GRAPH_EXECUTION_RUN_ID` when it is a valid id starting with `suite-` (graph-manager picks
 * a sandboxed suite's id before the container starts), else a generated one. Any other value, such as a run id a
 * launcher left in the environment, is ignored.
 */
export function newSuiteId(env: NodeJS.ProcessEnv = process.env): string {
  const forced = env[RUN_ID_ENV];
  if (forced !== undefined && forced.startsWith("suite-") && RUN_ID_PATTERN.test(forced)) return forced;
  return `suite-${generateRunId()}`;
}

/** Fails when the suite folder already holds a suite; a folder with only graph-manager's launcher files is fine. */
function assertNewSuite(home: string, suiteId: string): void {
  if (existsSync(path.join(suiteDirOf(home, suiteId), SUITE_FILE))) throw new UsageError(`suite ${suiteId} already exists`);
}

/** `sandbox: { image }` of a suite started inside a graph-manager sandbox (as a run's `state.json`), so a resume knows. */
function sandboxOf(env: NodeJS.ProcessEnv): { sandbox?: { image: string } } {
  return env[SANDBOX_ENV] === "1" ? { sandbox: { image: env[SANDBOX_IMAGE_ENV] ?? "" } } : {};
}

/** Validates the features, creates the suite folder with its `suite.json` and takes the lock. */
async function startSuite(opts: SuiteOptions): Promise<SuiteContext> {
  if (opts.project !== undefined) return startProjectSuite(opts);
  const log = opts.log ?? ((l: string) => console.log(l));
  const { features, names, reviewersFile } = await validateSuite(opts);

  const repo = await repoRoot(opts.cwd);
  const startingCommit = (await resolveRef(repo, "HEAD")) ?? "";
  const branch = await currentBranch(repo);
  const config = await loadConfig(repo);
  const concurrency = opts.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;

  const env = opts.env ?? process.env;
  const suiteId = newSuiteId(env);
  assertNewSuite(repo, suiteId);
  const suiteDir = suiteDirOf(repo, suiteId);
  await mkdir(path.join(suiteDir, "features"), { recursive: true });
  await mkdir(path.join(suiteDir, "logs"), { recursive: true });
  // Byte for byte, like a run: the feature runs and the e2e phase read this copy, never the user's file again.
  if (reviewersFile) await copyFile(reviewersFile, path.join(suiteDir, RUN_REVIEWERS_FILE));
  const release = await acquireLock(suiteDir);
  try {
    const runIds = new Set<string>();
    const suiteFeatures: SuiteFeature[] = features.map((f, i) => {
      let runId = generateRunId();
      while (runIds.has(runId)) runId = generateRunId();
      runIds.add(runId);
      return { name: names[i]!, ...f, runId, status: "queued" };
    });
    const store = new SuiteStore(path.join(suiteDir, SUITE_FILE), {
      suiteId,
      status: "running",
      provider: opts.provider,
      ...(opts.model ? { model: opts.model } : {}),
      concurrency,
      startingCommit,
      ...(branch && branch !== "HEAD" ? { startBranch: branch } : {}),
      merge: opts.merge,
      humanReview: opts.humanReview ?? config.humanReview,
      features: suiteFeatures,
      integration: { merged: [] },
      ...sandboxOf(env),
      createdAt: new Date().toISOString(),
    });
    await store.save();
    log(`Suite ${suiteId}: ${suiteFeatures.length} features, concurrency ${concurrency}`);
    await opts.onReady?.(suiteDir);
    return { suiteId, suiteDir, store, log, spawn: opts.spawn ?? defaultSpawnOf(opts.cliPath, repo), release, repo };
  } catch (err) {
    await release();
    throw err;
  }
}

/**
 * Restarts every feature that is not `done` or `excluded` under the same queue and cap rules, then continues as a
 * normal suite. A feature whose run exists is resumed; the others start fresh with their pre-generated run id.
 */
export async function resumeSuite(opts: ResumeSuiteOptions): Promise<ExitCode> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const repo = await repoRoot(opts.cwd);
  // A project folder gets no commits: the identity is checked per repo instead.
  if (!(await isProjectSuite(repo, opts.suiteId))) await assertGitIdentity(repo);
  const suiteDir = await findSuite(repo, opts.suiteId);
  const release = await acquireLock(suiteDir);
  try {
    // The suite's own integration/e2e agents a killed earlier CLI left running; feature runs reap on their own resume.
    await reapOrphans(suiteDir, { log });
    const store = await SuiteStore.load(path.join(suiteDir, SUITE_FILE));
    const suiteId = store.state.suiteId;
    if (store.state.status === "applied" || store.state.status === "done") {
      throw new UsageError(`suite ${suiteId} already finished`);
    }
    // A reviewer's missing CLI fails here, before anything restarts.
    await checkReviewerProviders(await readRunReviewers(suiteDir), store.state.provider, repo);
    await mkdir(path.join(suiteDir, "logs"), { recursive: true });
    if (store.state.project) return await resumeProject(opts, { repo, suiteDir, store, log, release });
    const wasIntegrating = store.state.status === "integrating" || store.state.status === "failed" && store.state.review !== undefined;
    await store.update((s) => {
      s.status = "running";
      delete s.error;
      for (const f of s.features) if (f.status === "running" || f.status === "stopped") f.status = "queued";
    });
    log(`Suite ${suiteId}: resuming, concurrency ${store.state.concurrency}`);
    await opts.onReady?.(suiteDir);
    const ctx: SuiteContext = {
      suiteId,
      suiteDir,
      store,
      log,
      spawn: opts.spawn ?? defaultSpawnOf(opts.cliPath, repo),
      release,
      repo,
    };
    const settled = store.state.features.every((f) => f.status === "done" || f.status === "excluded");
    const merged = store.state.features.filter((f) => f.status === "done").every((f) => store.state.integration.merged.includes(f.name));
    if (settled && wasIntegrating && store.state.integration.failed === undefined && merged && store.state.integrationBranch) {
      return await guarded(ctx, () => afterIntegration(ctx, opts), opts);
    }
    if (settled && store.state.integration.failed !== undefined) return await guarded(ctx, () => afterFeatures(ctx, opts), opts);
    return await driveFeatures(ctx, opts);
  } finally {
    await release();
  }
}

/** The loop: starts queued features under the cap, reacts to exits and to requests from the control. */
async function driveFeatures(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, suiteDir, log, spawn } = ctx;
  const control = opts.control;
  const state = store.state;
  const featuresRoot = path.join(suiteDir, "features");
  const logFileOf = (f: SuiteFeature): string => path.join(suiteDir, "logs", `${f.name}.log`);
  const suiteFeatures = state.features;
  const stopListeners: (() => void)[] = [];
  try {
    const running = new Map<SuiteFeature, { proc: FeatureProcess; exited: Promise<SuiteFeature> }>();
    const exitCodes = new Map<SuiteFeature, number>();
    // Queued, plus failed features of a resumed suite, which restart at once.
    const queue = suiteFeatures.filter((f) => f.status === "queued" || f.status === "failed");
    let aborted = false;
    let wake: (v: "abort") => void = () => {};
    const aborter = new Promise<"abort">((resolve) => {
      wake = resolve;
    });
    const stop = (): void => {
      if (aborted) return;
      aborted = true;
      for (const { proc } of running.values()) proc.stop();
      control?.quit();
      wake("abort");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    stopListeners.push(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
    if (opts.signal) {
      if (opts.signal.aborted) stop();
      else opts.signal.addEventListener("abort", stop, { once: true });
      stopListeners.push(() => opts.signal?.removeEventListener("abort", stop));
    }

    const anyWith = (status: SuiteFeature["status"]): boolean => suiteFeatures.some((f) => f.status === status);
    const idle = (): boolean => running.size === 0 && queue.length === 0;
    const sync = (): void =>
      control?.setAllowed(
        {
          retry: suiteFeatures.filter((f) => f.status === "failed" && !queue.includes(f)).map((f) => f.name),
          integrate: !state.project && idle() && anyWith("done") && anyWith("failed"),
        },
        suiteFeatures.map((f) => f.name),
      );
    const update = async (fn: () => void): Promise<void> => {
      await store.update(fn);
      sync();
    };

    const start = async (f: SuiteFeature, share: number): Promise<void> => {
      const resume = existsSync(path.join(featureRunDir(suiteDir, f.runId), "state.json"));
      // A resumed run keeps the concurrency saved in its state (`state.concurrency`, set from the original
      // `--concurrency`), so its share stays what it was; the `share` given here only applies to a fresh start.
      // A resumed run reads the copy in its own run dir; a fresh one gets the suite's copy.
      const reviewers = path.join(suiteDir, RUN_REVIEWERS_FILE);
      const proc = resume
        ? spawn(["--resume", "--run", f.runId], { [RUNS_ROOT_ENV]: featuresRoot }, logFileOf(f), f.repo?.path)
        : spawn(
            featureArgs(f, { provider: state.provider, model: state.model, share, ...(existsSync(reviewers) ? { reviewers } : {}) }),
            { [RUNS_ROOT_ENV]: featuresRoot, [RUN_ID_ENV]: f.runId },
            logFileOf(f),
            f.repo?.path,
          );
      const exited = proc.exited.then((code) => {
        exitCodes.set(f, code);
        return f;
      });
      running.set(f, { proc, exited });
      await update(() => {
        f.status = "running";
        if (!resume) f.share = share;
        f.pid = proc.pid;
        delete f.exitCode;
        delete f.finishedAt;
      });
      log(
        resume
          ? `feature ${f.name} resumed (run ${f.runId})`
          : `feature ${f.name} started (run ${f.runId}, concurrency ${share})`,
      );
    };
    /** Never more children at once than the suite's concurrency: counts running children, not features. */
    const pump = async (): Promise<void> => {
      while (!aborted && queue.length > 0 && running.size < state.concurrency) await start(queue.shift()!, 1);
    };

    sync();
    if (queue.length > 0) {
      for (const share of initialShares(state.concurrency, queue.length)) {
        if (aborted || queue.length === 0) break;
        await start(queue.shift()!, share);
      }
    }

    let pendingRequest: ReturnType<SuiteControl["next"]> | undefined;
    let outcome: "features-done" | "failed" | undefined;
    while (!aborted && !outcome) {
      if (idle()) {
        if (!anyWith("failed")) {
          outcome = anyWith("done") ? "features-done" : "failed";
          break;
        }
        if (!control) {
          outcome = "failed";
          break;
        }
      }
      const waits: Promise<{ exit: SuiteFeature } | { request: Awaited<ReturnType<SuiteControl["next"]>> } | "abort">[] = [
        aborter,
        ...[...running.values()].map((r) => r.exited.then((exit) => ({ exit }))),
      ];
      if (control) {
        pendingRequest ??= control.next();
        waits.push(pendingRequest.then((request) => ({ request })));
      }
      const ev = await Promise.race(waits);
      if (ev === "abort" || aborted) break;
      if ("exit" in ev) {
        const f = ev.exit;
        running.delete(f);
        const ok = await featureDone(featureRunDir(suiteDir, f.runId));
        const code = exitCodes.get(f) ?? 2;
        await update(() => {
          f.status = ok ? "done" : "failed";
          f.exitCode = code;
          f.finishedAt = new Date().toISOString();
        });
        log(ok ? `feature ${f.name} done` : `feature ${f.name} failed (exit ${code}), log: ${logFileOf(f)}`);
        await pump();
        continue;
      }
      pendingRequest = undefined;
      const req = ev.request;
      if (!req) {
        // The control was quit without a stop: nobody can answer any more.
        outcome = "failed";
      } else if ("retry" in req) {
        const f = suiteFeatures.find((x) => x.name === req.retry);
        if (f && f.status === "failed" && !queue.includes(f)) {
          // On disk the existence of the run's state.json decides between resume and a fresh start.
          queue.push(f);
          log(`feature ${f.name} queued for retry`);
          sync();
          await pump();
        }
      } else if (!state.project && idle() && anyWith("done") && anyWith("failed")) {
        await update(() => {
          for (const f of suiteFeatures) if (f.status === "failed") f.status = "excluded";
        });
        outcome = "features-done";
      }
    }

    if (aborted) {
      await Promise.all([...running.values()].map((r) => r.exited));
      await store.update((s) => {
        for (const f of s.features) if (f.status === "running") f.status = "stopped";
        s.status = "aborted";
      });
      log(`Suite ${ctx.suiteId} aborted`);
      return EXIT_ABORT;
    }

    if (outcome === "features-done") {
      return await guarded(ctx, () => (ctx.project ? afterProjectFeatures(ctx, opts) : afterFeatures(ctx, opts)), opts);
    }
    const failed = suiteFeatures.filter((f) => f.status !== "done" && f.status !== "excluded");
    await store.update((s) => {
      s.status = "failed";
    });
    log(`failed features: ${failed.map((f) => f.name).join(", ")}${state.project ? "; no repo was changed" : ""}`);
    if (!control) log("run graph-execution suite --resume to retry the failed features");
    return EXIT_ABORT;
  } finally {
    control?.setAllowed({ retry: [], integrate: false });
    for (const off of stopListeners) off();
  }
}

/** Integrates the features into `suite/<rid>`; a failed integration waits for a retry or ends `failed` (resume). */
/**
 * A stop during integration or the e2e/joint phase ends the suite as aborted, like a stop while features run. A phase
 * that gives up (an agent out of retries, validation failing every round) ends the suite `failed` with its error in
 * `suite.json`; a web suite then offers Retry, which runs the phase again where it stopped.
 */
async function guarded(ctx: SuiteContext, phase: () => Promise<ExitCode>, opts: DriveOptions = {}): Promise<ExitCode> {
  const { store, log } = ctx;
  const aborted = async (): Promise<ExitCode> => {
    await store.update((s) => {
      s.status = "aborted";
    });
    log(`Suite ${ctx.suiteId} aborted`);
    return EXIT_ABORT;
  };
  for (;;) {
    try {
      return await phase();
    } catch (err) {
      if (err instanceof InterruptedError) return await aborted();
      if (!(err instanceof AbortRunError)) throw err;
      await store.update((s) => {
        s.status = "failed";
        s.error = `${err.step}: ${err.message}`;
      });
      log(`error: ${err.step}: ${err.message}`);
      const control = opts.control;
      if (!control) {
        log(`run ${err.hint} to retry`);
        return EXIT_ABORT;
      }
      control.setAllowed({ retry: [], integrate: false, retryIntegration: true });
      const req = await control.next();
      control.setAllowed({ retry: [], integrate: false, retryIntegration: false });
      if (opts.signal?.aborted) return await aborted();
      if (!req || !("retryIntegration" in req)) return EXIT_ABORT;
      log(`retrying ${err.step}`);
      await store.update((s) => {
        delete s.error;
      });
    }
  }
}

async function afterFeatures(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, log } = ctx;
  const control = opts.control;
  const excluded = store.state.features.filter((f) => f.status === "excluded").map((f) => f.name);
  if (excluded.length > 0) log(`excluded: ${excluded.join(", ")}`);
  try {
    for (;;) {
      if ((await integrate(ctx, { repo: ctx.repo, signal: opts.signal })) === "merged") return await afterIntegration(ctx, opts);
      if (!control) break;
      control.setAllowed({ retry: [], integrate: false, retryIntegration: true });
      const req = await control.next();
      if (!req || !("retryIntegration" in req)) break;
      log("retrying the integration");
    }
  } finally {
    control?.setAllowed({ retry: [], integrate: false, retryIntegration: false });
  }
  await store.update((s) => {
    s.status = "failed";
  });
  if (!control) log("run graph-execution suite --resume to retry the integration");
  return EXIT_ABORT;
}

/**
 * The e2e phase on `suite/<rid>` and the single apply to the starting branch. A passed phase applies as uncommitted
 * changes (`applied`); `--no-merge`, a detached HEAD, an unreviewed result or a failed apply end `done`; open findings end `failed`.
 */
async function afterIntegration(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, log, suiteDir, repo } = ctx;
  const branch = suiteBranchOf(ctx.suiteId);
  await store.update((s) => {
    s.status = "integrating";
  });
  const result = await runE2e(ctx, opts.signal, opts.reviewHub, opts.reviewEvents);
  if (result.human?.decision === "drop") {
    await store.update((s) => {
      s.status = "done";
    });
    log(`dropped; the result is on ${branch}`);
    await removeWorktreeIfPresent(repo, integrationWorktreeOf(suiteDir));
    return result.exitCode;
  }
  // An apply the human forced goes on despite open findings.
  if (result.exitCode !== 0 && !result.human) {
    await store.update((s) => {
      s.status = "failed";
    });
    log(`e2e review failed: open findings in ${path.join(suiteDir, "reports")}`);
    return result.exitCode;
  }
  const { merge, startBranch } = store.state;
  let status: "applied" | "done" = "done";
  let files = 0;
  let conflicts: string[] = [];
  if (!merge) log(`the result is on ${branch}`);
  else if (!startBranch) log(`not applying: the suite started on a detached HEAD; the result is on ${branch}`);
  else if (codeReviewSkipped(result.reports)) {
    log(`not applying to ${startBranch}: the code review was not performed; the result is on ${branch}`);
  } else {
    const applied = await applyToCheckout(repo, startBranch, branch);
    if (applied.ok) {
      status = "applied";
      files = applied.files.length;
      conflicts = applied.conflicts;
      await store.update((s) => {
        s.applied = { files, conflicts };
      });
      log(`applied ${branch} to ${startBranch}: ${files} files, ${conflicts.length} conflicts`);
      for (const c of conflicts) log(`  conflict: ${c}`);
    } else log(`not applying to ${startBranch}: ${applied.reason}; the result is on ${branch}`);
  }
  await store.update((s) => {
    s.status = status;
  });
  const { features, integration } = store.state;
  log(`features merged: ${integration.merged.join(", ") || "none"}`);
  log(`features excluded: ${features.filter((f) => f.status === "excluded").map((f) => f.name).join(", ") || "none"}`);
  if (status === "applied") log(`files applied: ${files}, conflicts: ${conflicts.length}`);
  await removeWorktreeIfPresent(repo, integrationWorktreeOf(suiteDir));
  return EXIT_SUCCESS;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether the suite `resumeSuite` would pick in `repo` is a multi-repo one; false when there is none to read. */
async function isProjectSuite(repo: string, suiteId?: string): Promise<boolean> {
  try {
    const dir = await findSuite(repo, suiteId);
    return suiteStateSchema.parse(JSON.parse(await readFile(path.join(dir, SUITE_FILE), "utf8"))).project !== undefined;
  } catch {
    return false;
  }
}

/**
 * The checks of a multi-repo suite that need no suite folder: the project (`project.json` and its layout), the
 * reviewers file, then each repo in `project.json` order. A repo's problem is prefixed by its name.
 */
export async function validateProjectSuite(
  opts: Pick<SuiteOptions, "cwd" | "project" | "provider" | "merge" | "reviewers" | "env">,
): Promise<{ project: Project; reviewersFile?: string }> {
  const project = await loadProject(path.resolve(opts.cwd, opts.project ?? "."));
  if (!(await isRepo(project.dir)) || realpathSync.native(await repoRoot(project.dir)) !== project.dir) {
    throw new UsageError(`the project folder ${project.dir} must be a git repository: run git init there`);
  }
  const reviewersFile = await suiteReviewersFile(opts.cwd, opts.reviewers, opts.env ?? process.env);
  for (const repo of project.repos) {
    const refuse = (problem: string, cause?: unknown): never => {
      throw new UsageError(`${repo.name}: ${problem}`, cause === undefined ? undefined : { cause });
    };
    try {
      await assertGitIdentity(repo.path);
    } catch (err) {
      refuse(messageOf(err), err);
    }
    if ((await resolveRef(repo.path, "HEAD")) === undefined) refuse("the repository has no commits yet");
    if (await isDirty(repo.path, [RUNS_DIR])) refuse("working tree has uncommitted changes");
    if (opts.merge && (await currentBranch(repo.path)) === "HEAD") refuse("detached HEAD; check out a branch, or pass --no-merge");
    if (repo.tasksDir === undefined) continue;
    try {
      // The file is passed explicitly, and the env emptied, so each feature is checked with the suite's reviewers only.
      await preflight({
        cwd: repo.path,
        tasksDir: repo.tasksDir,
        spec: repo.spec,
        provider: opts.provider,
        ...(reviewersFile ? { reviewers: reviewersFile } : {}),
        env: {},
      });
    } catch (err) {
      throw new Error(`${repo.name}: ${messageOf(err)}`, { cause: err });
    }
  }
  return { project, ...(reviewersFile ? { reviewersFile } : {}) };
}

/** `startSuite` for `--project`: the suite folder is in the project folder, and each repo with tasks gets a feature. */
async function startProjectSuite(opts: SuiteOptions): Promise<SuiteContext> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { project, reviewersFile } = await validateProjectSuite(opts);

  await ensureExcluded(project.dir, `${RUNS_DIR}/`);
  const config = await loadConfig(project.dir);
  const concurrency = opts.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;
  const repos: SuiteRepo[] = [];
  for (const r of project.repos) {
    const branch = await currentBranch(r.path);
    repos.push({
      name: r.name,
      path: r.path,
      startingCommit: (await resolveRef(r.path, "HEAD")) ?? "",
      ...(branch && branch !== "HEAD" ? { startBranch: branch } : {}),
    });
  }

  const env = opts.env ?? process.env;
  const suiteId = newSuiteId(env);
  assertNewSuite(project.dir, suiteId);
  const suiteDir = suiteDirOf(project.dir, suiteId);
  for (const sub of ["features", "logs", "specs"]) await mkdir(path.join(suiteDir, sub), { recursive: true });
  if (reviewersFile) await copyFile(reviewersFile, path.join(suiteDir, RUN_REVIEWERS_FILE));
  const release = await acquireLock(suiteDir);
  try {
    const contract = await readFile(project.contract, "utf8");
    const runIds = new Set<string>();
    const suiteFeatures: SuiteFeature[] = [];
    for (const [i, r] of project.repos.entries()) {
      if (r.tasksDir === undefined || r.spec === undefined) continue;
      // The feature's spec: the repo's own, then the contract every repo shares.
      const prd = path.join(suiteDir, "specs", `${r.name}.md`);
      await writeFile(prd, `${(await readFile(r.spec, "utf8")).trimEnd()}\n\n## Contract\n\n${contract}`);
      let runId = generateRunId();
      while (runIds.has(runId)) runId = generateRunId();
      runIds.add(runId);
      suiteFeatures.push({ name: r.name, tasksDir: r.tasksDir, prd, runId, status: "queued", repo: repos[i]! });
    }
    const store = new SuiteStore(path.join(suiteDir, SUITE_FILE), {
      suiteId,
      status: "running",
      provider: opts.provider,
      ...(opts.model ? { model: opts.model } : {}),
      concurrency,
      startingCommit: (await resolveRef(project.dir, "HEAD")) ?? "",
      merge: opts.merge,
      humanReview: opts.humanReview ?? config.humanReview,
      features: suiteFeatures,
      project: { dir: project.dir, name: project.name, contract: project.contract },
      repos,
      integration: { merged: [] },
      ...sandboxOf(env),
      createdAt: new Date().toISOString(),
    });
    await store.save();
    // Member repos learn about the suite, so their own list/clean never take its branches for orphans.
    for (const r of repos) await linkProjectSuite(r.path, { suiteId, suiteDir, project: project.dir });
    log(
      `Suite ${suiteId}: ${suiteFeatures.length} feature(s) in ${suiteFeatures.map((f) => f.name).join(", ")}, concurrency ${concurrency}`,
    );
    await opts.onReady?.(suiteDir);
    return {
      suiteId,
      suiteDir,
      store,
      log,
      spawn: opts.spawn ?? defaultSpawnOf(opts.cliPath, project.dir),
      release,
      repo: project.dir,
      project,
    };
  } catch (err) {
    await release();
    throw err;
  }
}

/** `resumeSuite` for a multi-repo suite: unfinished features restart in their repos, else the branches, joint phase and apply. */
async function resumeProject(
  opts: ResumeSuiteOptions,
  base: Pick<SuiteContext, "repo" | "suiteDir" | "store" | "log" | "release">,
): Promise<ExitCode> {
  const { store, log, suiteDir } = base;
  const project = await loadProject(store.state.project!.dir);
  const saved = store.state.repos ?? [];
  if (project.repos.length !== saved.length || project.repos.some((r, i) => r.name !== saved[i]!.name || r.path !== saved[i]!.path)) {
    throw new UsageError("project.json changed since the suite started");
  }
  for (const r of project.repos) {
    try {
      await assertGitIdentity(r.path);
    } catch (err) {
      throw new UsageError(`${r.name}: ${messageOf(err)}`, { cause: err });
    }
  }
  await store.update((s) => {
    s.status = "running";
    delete s.error;
    for (const f of s.features) if (f.status === "running" || f.status === "stopped") f.status = "queued";
  });
  log(`Suite ${store.state.suiteId}: resuming, concurrency ${store.state.concurrency}`);
  await opts.onReady?.(suiteDir);
  const ctx: SuiteContext = {
    ...base,
    suiteId: store.state.suiteId,
    spawn: opts.spawn ?? defaultSpawnOf(opts.cliPath, project.dir),
    project,
  };
  if (store.state.features.every((f) => f.status === "done")) return await guarded(ctx, () => afterProjectFeatures(ctx, opts), opts);
  return await driveFeatures(ctx, opts);
}

/**
 * Every feature is done: each repo gets `suite/<rid>` (its feature run's result, or its starting commit when it has
 * no tasks), then the joint phase, then the apply of every repo or none. Safe to run again on resume.
 */
async function afterProjectFeatures(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, log, suiteDir, suiteId } = ctx;
  const branch = suiteBranchOf(suiteId);
  await store.update((s) => {
    s.status = "integrating";
    s.integrationBranch = branch;
  });
  for (const repo of store.state.repos ?? []) {
    let sha = await resolveRef(repo.path, `refs/heads/${branch}`);
    if (sha === undefined) {
      const feature = store.state.features.find((f) => f.name === repo.name);
      await createBranch(repo.path, feature ? (await readRunState(suiteDir, feature)).branch : repo.startingCommit, branch);
      sha = (await resolveRef(repo.path, `refs/heads/${branch}`)) ?? "";
    }
    log(`${repo.name}: ${branch} at ${sha.slice(0, 7)}`);
  }
  const joint = await jointPhase({
    suiteId,
    suiteDir,
    store,
    log,
    project: ctx.project!,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.reviewHub ? { reviewHub: opts.reviewHub } : {}),
    ...(opts.reviewEvents ? { reviewEvents: opts.reviewEvents } : {}),
  });
  if (joint.keep !== undefined) {
    await store.update((s) => {
      s.status = "done";
    });
    log(`${joint.keep}; results left on ${branch} in every repo`);
    await removeJointWorktrees(suiteDir, store.state.repos ?? []);
    return joint.exitCode ?? EXIT_SUCCESS;
  }
  if (!joint.ok) {
    await store.update((s) => {
      s.status = "failed";
    });
    log(`joint review failed: open findings in ${path.join(suiteDir, "reports")}; no repo was changed`);
    return joint.exitCode ?? EXIT_REVIEW_FAILED;
  }
  const code = await applyProject(ctx);
  // The suite ended `applied` or `done`; a failed or aborted one keeps its joint worktrees for the resume.
  await removeJointWorktrees(suiteDir, store.state.repos ?? []);
  return code;
}

/** Applies `suite/<rid>` to every repo's starting branch, or to none: every repo is checked before the first apply. */
async function applyProject(ctx: SuiteContext): Promise<ExitCode> {
  const { store, log } = ctx;
  const branch = suiteBranchOf(ctx.suiteId);
  const repos = store.state.repos ?? [];
  const kept = async (lines: string[]): Promise<ExitCode> => {
    for (const line of lines) log(line);
    await store.update((s) => {
      s.status = "done";
    });
    return EXIT_SUCCESS;
  };
  if (!store.state.merge) return kept(repos.map((r) => `${r.name}: the result is on ${branch}`));
  const detached = repos.find((r) => !r.startBranch);
  if (detached) return kept([`not applying: ${detached.name} started on a detached HEAD; results left on ${branch} in every repo`]);

  // An applied repo (a resumed apply) is dirty by design, so only the others are checked.
  const problems: string[] = [];
  for (const r of repos) {
    if (r.applied) continue;
    const on = await currentBranch(r.path);
    const head = (await resolveRef(r.path, "HEAD")) ?? "";
    if (on !== r.startBranch) problems.push(`${r.name}: the checkout is on ${on}, not on ${r.startBranch}`);
    else if (head !== r.startingCommit) {
      problems.push(`${r.name}: the checkout moved from ${r.startingCommit.slice(0, 7)} to ${head.slice(0, 7)} during the suite`);
    } else if (await isDirty(r.path, [RUNS_DIR])) problems.push(`${r.name}: working tree has uncommitted changes`);
  }
  if (problems.length > 0) return kept(problems.map((p) => `${p}; results left on ${branch} in every repo`));

  for (const r of repos) {
    if (r.applied) continue;
    // A repo without a feature is applied all the same once the joint fixer committed to it.
    if (!store.state.features.some((f) => f.name === r.name) && (await resolveRef(r.path, `refs/heads/${branch}`)) === r.startingCommit) {
      await store.update(() => {
        r.applied = { files: 0, conflicts: [] };
      });
      log(`${r.name}: unchanged`);
      continue;
    }
    const res = await applyToCheckout(r.path, r.startBranch!, branch);
    if (!res.ok) {
      const before = repos.filter((x) => x.applied && (x.applied.files > 0 || store.state.features.some((f) => f.name === x.name))).map((x) => x.name);
      return kept([
        `${r.name}: not applying: ${res.reason}; the result is on ${branch}`,
        ...(before.length > 0 ? [`already applied and left as they are: ${before.join(", ")}`] : []),
      ]);
    }
    await store.update(() => {
      r.applied = { files: res.files.length, conflicts: res.conflicts };
    });
    log(`${r.name}: applied ${branch} to ${r.startBranch}: ${res.files.length} files, ${res.conflicts.length} conflicts`);
    for (const c of res.conflicts) log(`  conflict: ${c}`);
  }
  await store.update((s) => {
    s.applied = {
      files: repos.reduce((n, r) => n + (r.applied?.files ?? 0), 0),
      conflicts: repos.flatMap((r) => (r.applied?.conflicts ?? []).map((c) => `${r.name}/${c}`)),
    };
    s.status = "applied";
  });
  return EXIT_SUCCESS;
}

/**
 * The hidden `--web-serve` suite process: the normal suite with a `SuiteControl` and the suite page, kept up after
 * the end until Close. Returns the suite's exit code once the page was closed.
 */
export async function serveSuite(opts: SuiteOptions | ResumeSuiteOptions, env: NodeJS.ProcessEnv = process.env): Promise<ExitCode> {
  const control = new SuiteControl();
  const reviewHub = new RetryHub();
  const reviewEvents = new RunEmitter();
  const abort = new AbortController();
  let running = true;
  let suiteDir: string | undefined;
  let server: SuiteServer | undefined;
  let closeDone: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closeDone = resolve;
  });
  const baseLog = opts.log ?? ((l: string) => console.log(l));
  const log = (line: string): void => {
    if (suiteDir) appendRunLog(suiteDir, line);
    baseLog(line);
  };
  const onReady = async (dir: string): Promise<void> => {
    suiteDir = dir;
    server = await createSuiteServer({
      suiteDir: dir,
      control,
      review: {
        hub: reviewHub,
        events: reviewEvents,
        suiteDir: dir,
        // A project suite's home is found from its folder: the CLI may run from elsewhere.
        repo: "project" in opts && opts.project !== undefined ? path.resolve(dir, "..", "..") : await repoRoot(opts.cwd),
      },
      isRunning: () => running,
      onAbort: () => {
        abort.abort();
        control.quit();
        reviewHub.quit();
      },
      onClose: closeDone,
      listen: listenFromEnv(env),
    });
    // `host` lets graph-manager tell a container's pid from one of its own.
    await writeFile(webJsonPath(dir), JSON.stringify({ url: server.url, pid: process.pid, host: os.hostname() }));
    await announceReady(env, { url: server.url, runId: path.basename(dir) });
  };
  const common = { control, reviewHub, reviewEvents, signal: abort.signal, log, onReady };
  let exitCode: ExitCode = EXIT_ABORT;
  try {
    exitCode = "features" in opts ? await runSuite({ ...opts, ...common }) : await resumeSuite({ ...opts, ...common });
  } catch (err) {
    // Before the page is up the launcher sees the process die; afterwards the page stays for Close.
    if (!server) throw err;
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  running = false;
  if (server && suiteDir) {
    await closed;
    control.quit();
    reviewHub.quit();
    await rm(webJsonPath(suiteDir), { force: true });
  }
  return exitCode;
}
