import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/config.js";
import { applyToCheckout, currentBranch, ensureExcluded, isRepo, removeWorktreeIfPresent, repoRoot, resolveRef } from "../git/git.js";
import { preflight, UsageError } from "../launch/preflight.js";
import { DEFAULT_CONCURRENCY } from "../runner/run.js";
import { generateRunId } from "../runner/startup.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode, InterruptedError } from "../state/errors.js";
import { RUN_ID_ENV, RUNS_DIR, RUNS_ROOT_ENV } from "../state/paths.js";
import { acquireLock, stateSchema } from "../state/state.js";
import { SuiteControl } from "./control.js";
import { RetryHub } from "../runner/retry-hub.js";
import { RunEmitter } from "../runner/events.js";
import { createSuiteServer, type SuiteServer } from "./server.js";
import { announceReady, appendRunLog, webJsonPath } from "../web/serve.js";
import { codeReviewSkipped } from "../review/phase.js";
import { treeConflicts } from "./changes.js";
import { integrationWorktreeOf, runE2e, suiteBranchOf } from "./e2e.js";
import { integrate } from "./integrate.js";
import { initialShares } from "./shares.js";
import { defaultSpawn, featureArgs, type FeatureProcess, type SpawnFeature } from "./spawn.js";
import { featureRunDir, SUITE_FILE, type SuiteFeature, SuiteStore, suiteDirOf, suiteHome, type SuiteRepo } from "./state.js";

export interface SuiteOptions {
  cwd: string;
  features: { tasksDir: string; prd: string }[];
  provider: string;
  model?: string;
  concurrency?: number;
  merge: boolean;
  /** `--human-review` / `--no-human-review`; undefined lets the config decide. */
  humanReview?: boolean;
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
  /** The spawn of a feature's child: runs in the feature's repo. */
  spawnFor: (f: SuiteFeature) => SpawnFeature;
  release: () => Promise<void>;
  /** `repos[0].root`, for the code that is not yet per repo. */
  repo: string;
  /** Where the suite folder lives: the git root of the launch folder, or the folder itself. */
  home: string;
}

type DriveOptions = Pick<SuiteOptions, "control" | "signal" | "reviewHub" | "reviewEvents">;

function uniqueNames(dirs: string[], fallback = "feature"): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    const base = path.basename(dir).replace(/[^A-Za-z0-9_-]/g, "-") || fallback;
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

async function findSuite(home: string, suiteId?: string): Promise<string> {
  const root = path.join(home, RUNS_DIR);
  if (suiteId !== undefined) {
    const dir = suiteDirOf(home, suiteId);
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

/** A spawn per feature: `spawn` when given (tests), else the built CLI with the feature's repo as cwd, cached per repo. */
function spawnForOf(
  opts: { spawn?: SpawnFeature; cliPath?: string },
  repos: SuiteRepo[],
): (f: SuiteFeature) => SpawnFeature {
  if (opts.spawn) return () => opts.spawn!;
  const cache = new Map<string, SpawnFeature>();
  return (f) => {
    const root = repos.find((r) => r.name === f.repo)?.root ?? repos[0]!.root;
    let spawn = cache.get(root);
    if (!spawn) {
      spawn = defaultSpawnOf(opts.cliPath, root);
      cache.set(root, spawn);
    }
    return spawn;
  };
}

export async function runSuite(opts: SuiteOptions): Promise<ExitCode> {
  const ctx = await startSuite(opts);
  try {
    return await driveFeatures(ctx, opts);
  } finally {
    await ctx.release();
  }
}

/** The checks that need no suite folder: at least 2 features, distinct folders, the preflight of each. */
export async function validateSuite(
  opts: Pick<SuiteOptions, "cwd" | "features" | "provider">,
): Promise<{
  features: { tasksDir: string; prd: string; repo: string }[];
  names: string[];
  repos: { name: string; root: string }[];
}> {
  if (opts.features.length < 2) throw new UsageError("a suite needs at least 2 --feature");
  const features = opts.features.map((f) => ({
    tasksDir: path.resolve(opts.cwd, f.tasksDir),
    prd: path.resolve(opts.cwd, f.prd),
  }));
  const names = uniqueNames(features.map((f) => f.tasksDir));
  if (new Set(features.map((f) => f.tasksDir)).size !== features.length) {
    throw new UsageError("two features use the same tasks folder");
  }
  const roots: string[] = [];
  for (const f of features) {
    if (!existsSync(f.tasksDir)) throw new UsageError(`--feature ${f.tasksDir}: folder not found`);
    if (!(await isRepo(f.tasksDir))) throw new UsageError(`--feature ${f.tasksDir}: not in a git repo`);
    const root = await repoRoot(f.tasksDir);
    if (!roots.includes(root)) roots.push(root);
  }
  const repoNames = uniqueNames(roots, "repo");
  const repos = roots.map((root, i) => ({ name: repoNames[i]!, root }));
  const rootOfFeature: string[] = [];
  for (const [i, f] of features.entries()) {
    const root = await repoRoot(f.tasksDir);
    rootOfFeature.push(root);
    try {
      await preflight({ cwd: root, tasksDir: f.tasksDir, spec: f.prd, provider: opts.provider });
    } catch (err) {
      throw new Error(`${names[i]}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return {
    features: features.map((f, i) => ({ ...f, repo: repos.find((r) => r.root === rootOfFeature[i])!.name })),
    names,
    repos,
  };
}

/** Tells every repo other than `home` where the suite lives, so `clean` there does not take its branches for orphans. */
async function writePointers(home: string, suiteDir: string, suiteId: string, repos: SuiteRepo[], features: SuiteFeature[]): Promise<void> {
  for (const r of repos) {
    if (r.root === home) continue;
    const dir = path.join(r.root, RUNS_DIR, "_suites");
    await mkdir(dir, { recursive: true });
    await ensureExcluded(r.root, `${RUNS_DIR}/`);
    const mine = features.filter((f) => f.repo === r.name).map((f) => f.runId);
    await writeFile(path.join(dir, `${suiteId}.json`), `${JSON.stringify({ suiteDir, features: mine }, null, 2)}\n`);
  }
}

/** Validates the features, creates the suite folder with its `suite.json` and takes the lock. */
async function startSuite(opts: SuiteOptions): Promise<SuiteContext> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { features, names, repos: found } = await validateSuite(opts);

  const home = await suiteHome(opts.cwd);
  const repos: SuiteRepo[] = [];
  for (const r of found) {
    const branch = await currentBranch(r.root);
    repos.push({
      name: r.name,
      root: r.root,
      startingCommit: (await resolveRef(r.root, "HEAD")) ?? "",
      ...(branch && branch !== "HEAD" ? { startBranch: branch } : {}),
    });
  }
  const first = repos[0]!;
  const repo = first.root;
  const config = await loadConfig(home);
  const concurrency = opts.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;

  const suiteId = `suite-${generateRunId()}`;
  const suiteDir = suiteDirOf(home, suiteId);
  await mkdir(path.join(suiteDir, "features"), { recursive: true });
  await mkdir(path.join(suiteDir, "logs"), { recursive: true });
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
      startingCommit: first.startingCommit,
      ...(first.startBranch ? { startBranch: first.startBranch } : {}),
      repos,
      merge: opts.merge,
      humanReview: opts.humanReview ?? config.humanReview,
      features: suiteFeatures,
      integration: { merged: [] },
      createdAt: new Date().toISOString(),
    });
    await store.save();
    await writePointers(home, suiteDir, suiteId, repos, suiteFeatures);
    log(`Suite ${suiteId}: ${suiteFeatures.length} features, concurrency ${concurrency}`);
    await opts.onReady?.(suiteDir);
    return { suiteId, suiteDir, store, log, spawnFor: spawnForOf(opts, repos), release, repo, home };
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
  const home = await suiteHome(opts.cwd);
  const suiteDir = await findSuite(home, opts.suiteId);
  const release = await acquireLock(suiteDir);
  try {
    const store = await SuiteStore.load(path.join(suiteDir, SUITE_FILE));
    const suiteId = store.state.suiteId;
    for (const r of store.state.repos) {
      const branch = store.state.integrationBranch;
      if (!(await isRepo(r.root)) || (branch !== undefined && !(await resolveRef(r.root, branch)))) {
        throw new Error(`suite ${suiteId}: repo ${r.root} not found`);
      }
    }
    if (store.state.status === "applied" || store.state.status === "done") {
      throw new UsageError(`suite ${suiteId} already finished`);
    }
    await mkdir(path.join(suiteDir, "logs"), { recursive: true });
    const wasIntegrating = store.state.status === "integrating" || store.state.status === "failed" && store.state.review !== undefined;
    await store.update((s) => {
      s.status = "running";
      for (const f of s.features) if (f.status === "running" || f.status === "stopped") f.status = "queued";
    });
    log(`Suite ${suiteId}: resuming, concurrency ${store.state.concurrency}`);
    await opts.onReady?.(suiteDir);
    const ctx: SuiteContext = {
      suiteId,
      suiteDir,
      store,
      log,
      spawnFor: spawnForOf(opts, store.state.repos),
      release,
      repo: store.state.repos[0]!.root,
      home,
    };
    const settled = store.state.features.every((f) => f.status === "done" || f.status === "excluded");
    const merged = store.state.features.filter((f) => f.status === "done").every((f) => store.state.integration.merged.includes(f.name));
    if (settled && wasIntegrating && store.state.integration.failed === undefined && merged && store.state.integrationBranch) {
      return await guarded(ctx, () => afterIntegration(ctx, opts));
    }
    if (settled && store.state.integration.failed !== undefined) return await guarded(ctx, () => afterFeatures(ctx, opts));
    return await driveFeatures(ctx, opts);
  } finally {
    await release();
  }
}

/** The loop: starts queued features under the cap, reacts to exits and to requests from the control. */
async function driveFeatures(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, suiteDir, log, spawnFor } = ctx;
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
          integrate: idle() && anyWith("done") && anyWith("failed"),
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
      const spawn = spawnFor(f);
      const proc = resume
        ? spawn(["--resume", "--run", f.runId], { [RUNS_ROOT_ENV]: featuresRoot }, logFileOf(f))
        : spawn(
            featureArgs(f, { provider: state.provider, model: state.model, share }),
            { [RUNS_ROOT_ENV]: featuresRoot, [RUN_ID_ENV]: f.runId },
            logFileOf(f),
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
      } else if (idle() && anyWith("done") && anyWith("failed")) {
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

    if (outcome === "features-done") return await guarded(ctx, () => afterFeatures(ctx, opts));
    const failed = suiteFeatures.filter((f) => f.status !== "done" && f.status !== "excluded");
    await store.update((s) => {
      s.status = "failed";
    });
    log(`failed features: ${failed.map((f) => f.name).join(", ")}`);
    if (!control) log("run graph-execution suite --resume to retry the failed features");
    return EXIT_ABORT;
  } finally {
    control?.setAllowed({ retry: [], integrate: false });
    for (const off of stopListeners) off();
  }
}

/** Integrates the features into `suite/<rid>`; a failed integration waits for a retry or ends `failed` (resume). */
/** A stop during integration or the e2e phase ends the suite as aborted, like a stop while features run. */
async function guarded(ctx: SuiteContext, phase: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await phase();
  } catch (err) {
    if (!(err instanceof InterruptedError)) throw err;
    await ctx.store.update((s) => {
      s.status = "aborted";
    });
    ctx.log(`Suite ${ctx.suiteId} aborted`);
    return EXIT_ABORT;
  }
}

async function afterFeatures(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, log } = ctx;
  const control = opts.control;
  const excluded = store.state.features.filter((f) => f.status === "excluded").map((f) => f.name);
  if (excluded.length > 0) log(`excluded: ${excluded.join(", ")}`);
  try {
    for (;;) {
      if ((await integrate(ctx, { signal: opts.signal })) === "merged") return await afterIntegration(ctx, opts);
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

/** Why a repo cannot take `suite/<rid>`; an empty list means every repo can. */
async function applyBlockers(repos: SuiteRepo[], branch: string): Promise<{ name: string; reason: string }[]> {
  const blockers: { name: string; reason: string }[] = [];
  for (const r of repos) {
    if (!r.startBranch) {
      blockers.push({ name: r.name, reason: "the suite started on a detached HEAD" });
      continue;
    }
    const current = await currentBranch(r.root);
    if (current !== r.startBranch) {
      blockers.push({ name: r.name, reason: `the checkout is on ${current}, not on ${r.startBranch}` });
      continue;
    }
    const conflicted = await treeConflicts(r.root, "HEAD", branch);
    if (conflicted.length > 0) blockers.push({ name: r.name, reason: `${branch} conflicts with ${r.startBranch}: ${conflicted.join(", ")}` });
  }
  return blockers;
}

/**
 * The e2e phase on `suite/<rid>` and the single apply to the starting branch. A passed phase applies as uncommitted
 * changes (`applied`); `--no-merge`, a detached HEAD, an unreviewed result or a failed apply end `done`; open findings end `failed`.
 */
async function afterIntegration(ctx: SuiteContext, opts: DriveOptions): Promise<ExitCode> {
  const { store, log, suiteDir } = ctx;
  const multi = store.state.repos.length > 1;
  const removeWorktrees = async (): Promise<void> => {
    for (const r of store.state.repos) await removeWorktreeIfPresent(r.root, integrationWorktreeOf(suiteDir, r, multi));
  };
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
    await removeWorktrees();
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
  else if (!multi && !startBranch) log(`not applying: the suite started on a detached HEAD; the result is on ${branch}`);
  else if (codeReviewSkipped(result.reports)) {
    log(`not applying to ${startBranch ?? "the starting branch"}: the code review was not performed; the result is on ${branch}`);
  } else if (!multi) {
    const applied = await applyToCheckout(store.state.repos[0]!.root, startBranch!, branch);
    if (applied.ok) {
      status = "applied";
      files = applied.files.length;
      conflicts = applied.conflicts;
      await store.update((s) => {
        s.applied = { files, conflicts };
        s.repos[0]!.applied = { files, conflicts };
      });
      log(`applied ${branch} to ${startBranch}: ${files} files, ${conflicts.length} conflicts`);
      for (const c of conflicts) log(`  conflict: ${c}`);
    } else log(`not applying to ${startBranch}: ${applied.reason}; the result is on ${branch}`);
  } else {
    const repos = store.state.repos;
    const blockers = await applyBlockers(repos, branch);
    if (blockers.length > 0) {
      for (const b of blockers) log(`${b.name}: not applying: ${b.reason}`);
      log(`nothing applied; the results are on ${branch} in every repo`);
    } else {
      const done: string[] = [];
      for (const [i, r] of repos.entries()) {
        const applied = await applyToCheckout(r.root, r.startBranch!, branch);
        if (!applied.ok) {
          log(`${r.name}: apply failed: ${applied.reason}; applied so far: ${done.join(", ") || "none"}`);
          break;
        }
        done.push(r.name);
        const rf = applied.files.length;
        await store.update((s) => {
          s.repos[i]!.applied = { files: rf, conflicts: applied.conflicts };
          if (i === 0) s.applied = { files: rf, conflicts: applied.conflicts };
        });
        files += rf;
        conflicts = conflicts.concat(applied.conflicts.map((c) => `${r.name}/${c}`));
        log(`${r.name}: applied ${branch} to ${r.startBranch}: ${rf} files, ${applied.conflicts.length} conflicts`);
        for (const c of applied.conflicts) log(`  conflict: ${r.name}/${c}`);
      }
      if (done.length === repos.length) status = "applied";
    }
  }
  await store.update((s) => {
    s.status = status;
  });
  const { features, integration } = store.state;
  log(`features merged: ${integration.merged.join(", ") || "none"}`);
  log(`features excluded: ${features.filter((f) => f.status === "excluded").map((f) => f.name).join(", ") || "none"}`);
  if (status === "applied") log(`files applied: ${files}, conflicts: ${conflicts.length}`);
  await removeWorktrees();
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
      review: await (async () => {
        const repos = (await SuiteStore.load(path.join(dir, SUITE_FILE))).state.repos;
        return { hub: reviewHub, events: reviewEvents, suiteDir: dir, repo: repos[0]!.root, roots: Object.fromEntries(repos.map((r) => [r.name, r.root])) };
      })(),
      isRunning: () => running,
      onAbort: () => {
        abort.abort();
        control.quit();
        reviewHub.quit();
      },
      onClose: closeDone,
    });
    await writeFile(webJsonPath(dir), JSON.stringify({ url: server.url, pid: process.pid }));
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
