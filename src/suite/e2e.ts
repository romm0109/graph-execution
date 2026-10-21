import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTestPlan, TEST_PLAN_FILE, type TestCase } from "../graph/testPlan.js";
import { rangeChanges } from "../git/git.js";
import { createMergeLock } from "../git/mutex.js";
import { checkEnvironment } from "../launch/preflight.js";
import { type ReviewPhaseResult, runReviewPhase } from "../review/phase.js";
import type { RunEmitter } from "../runner/events.js";
import type { RetryHub } from "../runner/retry-hub.js";
import { stateSchema, initialReviewState } from "../state/state.js";
import { featureRunDir, type SuiteFeature, type SuiteStore } from "./state.js";

export interface E2eContext {
  suiteId: string;
  suiteDir: string;
  store: SuiteStore;
  log: (line: string) => void;
  repo: string;
}

export const integrationWorktreeOf = (suiteDir: string): string => path.join(suiteDir, "worktrees", "integration");
export const suiteBranchOf = (suiteId: string): string => `suite/${suiteId.slice("suite-".length)}`;

/** The features whose branch is in `suite/<rid>`, in merge order. */
const includedFeatures = (ctx: E2eContext): SuiteFeature[] => {
  const { features, integration } = ctx.store.state;
  return integration.merged.flatMap((name) => features.filter((f) => f.name === name));
};

async function readRunState(suiteDir: string, f: SuiteFeature): Promise<{ startingCommit: string; branch: string }> {
  const parsed = stateSchema.parse(
    JSON.parse(await readFile(path.join(featureRunDir(suiteDir, f.runId), "state.json"), "utf8")),
  );
  return { startingCommit: parsed.startingCommit, branch: parsed.integrationBranch };
}

/** Writes the combined spec (every included PRD) and the combined test plan (case ids prefixed by feature name). */
export async function buildSuiteInputs(ctx: E2eContext): Promise<{ specPath: string; tasksDir: string }> {
  const dir = path.join(ctx.suiteDir, "e2e");
  const tasksDir = path.join(dir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const features = includedFeatures(ctx);
  const specs = await Promise.all(features.map(async (f) => `# Feature ${f.name}\n\n${await readFile(f.prd, "utf8")}`));
  const specPath = path.join(dir, "spec.md");
  await writeFile(specPath, specs.join("\n\n"));

  const cases: TestCase[] = [];
  for (const f of features) {
    const plan = await loadTestPlan(f.tasksDir);
    for (const c of plan?.cases ?? []) cases.push({ ...c, id: `${f.name}-${c.id}`, title: `[${f.name}] ${c.title}` });
  }
  const planFile = path.join(tasksDir, TEST_PLAN_FILE);
  if (cases.length > 0) await writeFile(planFile, `${JSON.stringify({ cases }, null, 2)}\n`);
  else await rm(planFile, { force: true });
  return { specPath, tasksDir };
}

/** The sorted paths changed by at least 2 of the included features. */
export async function overlapFiles(ctx: E2eContext): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const f of includedFeatures(ctx)) {
    const run = await readRunState(ctx.suiteDir, f);
    for (const c of await rangeChanges(ctx.repo, run.startingCommit, run.branch)) {
      counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n >= 2).map(([p]) => p).sort();
}

/** The review phase on `suite/<rid>`: validation, then (with `e2eReview`) the cross-feature reviewer, the tester and the fixer. */
export async function runE2e(ctx: E2eContext, signal?: AbortSignal, hub?: RetryHub, events?: RunEmitter): Promise<ReviewPhaseResult> {
  const { store, suiteDir, log } = ctx;
  const state = store.state;
  const env = await checkEnvironment({ cwd: ctx.repo, provider: state.provider });
  const { specPath, tasksDir } = await buildSuiteInputs(ctx);
  if (state.humanReview && !hub) log("humanReview needs the web view; applying without a human review");
  return runReviewPhase({
    provider: env.provider,
    config: env.config,
    repo: ctx.repo,
    runDir: suiteDir,
    integrationWorktree: integrationWorktreeOf(suiteDir),
    integrationBranch: state.integrationBranch ?? suiteBranchOf(ctx.suiteId),
    startingCommit: state.startingCommit,
    specPath,
    tasksDir,
    signal: signal ?? new AbortController().signal,
    hint: "graph-execution suite --resume",
    ...(state.model ? { model: state.model } : {}),
    log,
    ...(events ? { events } : {}),
    ...(state.humanReview && hub ? { human: { wait: () => hub.waitReview() } } : {}),
    withLock: createMergeLock(),
    reviewFiles: await overlapFiles(ctx),
    validateOnly: !env.config.e2eReview,
    progress: state.review ?? initialReviewState(),
    onProgress: (progress) =>
      store.update((s) => {
        s.review = structuredClone(progress);
      }),
  });
}
