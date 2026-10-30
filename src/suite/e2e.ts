import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTestPlan, TEST_PLAN_FILE, type TestCase } from "../graph/testPlan.js";
import { rangeChanges } from "../git/git.js";
import { createMergeLock } from "../git/mutex.js";
import { checkEnvironment } from "../launch/preflight.js";
import { loadConfig } from "../config/config.js";
import { type ReviewPhaseResult, type ReviewRepo, runReviewPhase } from "../review/phase.js";
import { RunEmitter } from "../runner/events.js";
import { teeOutput } from "../runner/run.js";
import { watchIdle } from "../agents/idle.js";
import { watchLoops } from "../agents/loop.js";
import { writeAgentLogs } from "../ui/store.js";
import type { RetryHub } from "../runner/retry-hub.js";
import { stateSchema, initialReviewState } from "../state/state.js";
import { freePorts } from "./ports.js";
import { featureRunDir, type SuiteFeature, type SuiteStore } from "./state.js";

export interface E2eContext {
  suiteId: string;
  suiteDir: string;
  store: SuiteStore;
  log: (line: string) => void;
  repo: string;
  /** Where the suite folder lives; its config sets the suite-wide review options. */
  home: string;
}

/** One repo's integration worktree: `worktrees/integration` with one repo, `e2e/workspace/<name>` with several. */
export const integrationWorktreeOf = (suiteDir: string, repo?: { name: string }, multi = false): string =>
  multi && repo ? path.join(suiteDir, "e2e", "workspace", repo.name) : path.join(suiteDir, "worktrees", "integration");
/** The combined e2e workspace of a multi-repo suite: one folder per repo. */
export const e2eWorkspaceOf = (suiteDir: string): string => path.join(suiteDir, "e2e", "workspace");
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

/** `SUITE_PORT_<REPO_NAME>` (upper-cased, `-` to `_`) for every repo that has a port. */
export function portEnv(ports: Record<string, number> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ports ?? {}).map(([name, port]) => [`SUITE_PORT_${name.toUpperCase().replace(/-/g, "_")}`, String(port)]),
  );
}

/** The "Repos" section for the e2e agents: what each folder of the combined workspace is and which port its app uses. Empty with one repo. */
function reposSection(ctx: E2eContext, features: SuiteFeature[]): string[] {
  const { repos, e2ePorts } = ctx.store.state;
  if (repos.length < 2) return [];
  const rows = repos.map((r) => {
    const names = features.filter((f) => f.repo === r.name).map((f) => f.name);
    return `| \`${r.name}/\` | ${names.length > 0 ? names.join(", ") : "—"} | ${e2ePorts?.[r.name] ?? "—"} |`;
  });
  const first = repos[0]!.name;
  const port = e2ePorts?.[first];
  return [
    [
      "# Repos",
      "",
      "This folder holds several git repos, one per folder. Each is a separate git repo: commit in the repo you changed.",
      "",
      "| Folder | Features | Port |",
      "|---|---|---|",
      ...rows,
      "",
      `Each repo's port is also in the environment variable ${repos.map((r) => `\`${Object.keys(portEnv({ [r.name]: 0 }))[0]}\``).join(", ")}.`,
      "",
      `When you start a repo's app, start it on its port (for example \`PORT=${port ?? "<port>"}\`), and point the other repos at it (for example the frontend's API URL is \`http://localhost:${port ?? "<port>"}\`). Stop what you started before you finish.`,
    ].join("\n"),
  ];
}

/** Writes the combined spec (every included PRD) and the combined test plan (case ids prefixed by feature name). */
export async function buildSuiteInputs(ctx: E2eContext): Promise<{ specPath: string; tasksDir: string }> {
  const dir = path.join(ctx.suiteDir, "e2e");
  const tasksDir = path.join(dir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const features = includedFeatures(ctx);
  const specs = await Promise.all(features.map(async (f) => `# Feature ${f.name}\n\n${await readFile(f.prd, "utf8")}`));
  const specPath = path.join(dir, "spec.md");
  await writeFile(specPath, [...reposSection(ctx, features), ...specs].join("\n\n"));

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

/** The sorted paths changed by at least 2 of the included features of the same repo (`<name>/<path>` with several repos). */
export async function overlapFiles(ctx: E2eContext): Promise<string[]> {
  const counts = new Map<string, number>();
  const { repos } = ctx.store.state;
  const multi = repos.length > 1;
  for (const f of includedFeatures(ctx)) {
    const r = repos.find((x) => x.name === f.repo) ?? repos[0]!;
    const run = await readRunState(ctx.suiteDir, f);
    for (const c of await rangeChanges(r.root, run.startingCommit, run.branch)) {
      const key = multi ? `${r.name}/${c.path}` : c.path;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n >= 2).map(([p]) => p).sort();
}

/** The review phase on `suite/<rid>`: validation, then (with `e2eReview`) the cross-feature reviewer, the tester and the fixer. */
export async function runE2e(ctx: E2eContext, signal?: AbortSignal, hub?: RetryHub, events?: RunEmitter): Promise<ReviewPhaseResult> {
  const { store, suiteDir, log } = ctx;
  const state = store.state;
  const multi = state.repos.length > 1;
  const first = state.repos[0]!;
  const env = await checkEnvironment({ cwd: first.root, provider: state.provider });
  const suiteConfig = await loadConfig(ctx.home);
  const integrationBranch = state.integrationBranch ?? suiteBranchOf(ctx.suiteId);
  const repos: ReviewRepo[] = await Promise.all(
    state.repos.map(async (r) => ({
      name: r.name,
      repo: r.root,
      integrationWorktree: integrationWorktreeOf(suiteDir, r, multi),
      integrationBranch,
      startingCommit: r.startingCommit,
      config: await loadConfig(r.root),
    })),
  );
  if (multi && !state.e2ePorts) {
    const ports = await freePorts(state.repos.length);
    await store.update((s) => {
      s.e2ePorts = Object.fromEntries(s.repos.map((r, i) => [r.name, ports[i]!]));
    });
  }
  const agentEnv = multi ? portEnv(store.state.e2ePorts) : {};
  const { specPath, tasksDir } = await buildSuiteInputs(ctx);
  if (state.humanReview && !hub) log("humanReview needs the web view; applying without a human review");
  // The e2e agents' full output goes to logs/<label>.log, like in a run (PRD §6).
  const output = new RunEmitter();
  const stopLogs = writeAgentLogs(output, path.join(suiteDir, "logs"));
  return runReviewPhase({
    provider: teeOutput(
      watchIdle(
        watchLoops(
          { name: env.provider.name, run: (o) => env.provider.run({ ...o, env: { ...agentEnv, ...o.env } }) },
          suiteConfig.loopDetection,
          (label, why) => log(`[${label}] stopped: ${why}; retrying`),
        ),
        suiteConfig.idleTimeoutMinutes,
        (label, why) => log(`[${label}] stopped: ${why}; retrying`),
      ),
      output,
    ),
    config: suiteConfig,
    repo: first.root,
    runDir: suiteDir,
    integrationWorktree: integrationWorktreeOf(suiteDir, first, multi),
    integrationBranch,
    startingCommit: first.startingCommit,
    ...(multi ? { repos, workspace: e2eWorkspaceOf(suiteDir) } : {}),
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
    validateOnly: !suiteConfig.e2eReview,
    progress: state.review ?? initialReviewState(),
    onProgress: (progress) =>
      store.update((s) => {
        s.review = structuredClone(progress);
      }),
  }).finally(stopLogs);
}
