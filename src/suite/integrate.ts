import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveConflicts, type FeatureSpec } from "../agents/resolver.js";
import {
  addWorktree,
  cleanWorktree,
  createBranch,
  isAncestor,
  merge,
  rangeChanges,
  resolveRef,
} from "../git/git.js";
import { checkEnvironment } from "../launch/preflight.js";
import { RunEmitter } from "../runner/events.js";
import { teeOutput } from "../runner/run.js";
import { watchIdle } from "../agents/idle.js";
import { watchLoops } from "../agents/loop.js";
import { writeAgentLogs } from "../ui/store.js";
import { RetriesExhaustedError } from "../state/errors.js";
import { stateSchema } from "../state/state.js";
import { featureRunDir, type IntegrationAgent, type SuiteFeature, type SuiteRepo, type SuiteStore } from "./state.js";
import { integrationWorktreeOf } from "./e2e.js";

type ChangesOf = Awaited<ReturnType<typeof rangeChanges>>;

export interface IntegrateContext {
  suiteId: string;
  suiteDir: string;
  store: SuiteStore;
  log: (line: string) => void;
}

export interface IntegrateOptions {
  signal?: AbortSignal;
}

async function readRunState(suiteDir: string, f: SuiteFeature): Promise<{ startingCommit: string; branch: string }> {
  const parsed = stateSchema.parse(
    JSON.parse(await readFile(path.join(featureRunDir(suiteDir, f.runId), "state.json"), "utf8")),
  );
  return { startingCommit: parsed.startingCommit, branch: parsed.integrationBranch };
}

/**
 * In every repo, merges its `done` features into `suite/<rid>`, in finish order. A conflict goes to the integration agent
 * (the merge resolver, given the PRDs of the features of that repo involved). Returns `failed` when the agent gave up; the
 * failing feature is saved in `integration.failed`. Entering again starts from clean worktrees and skips the features already merged.
 */
export async function integrate(ctx: IntegrateContext, opts: IntegrateOptions): Promise<"merged" | "failed"> {
  const { store, suiteDir } = ctx;
  const state = store.state;
  const multi = state.repos.length > 1;
  const branch = `suite/${ctx.suiteId.slice("suite-".length)}`;
  const worktrees = new Map<string, string>();
  for (const r of state.repos) {
    if ((await resolveRef(r.root, branch)) === undefined) await createBranch(r.root, r.startingCommit, branch);
    const worktree = integrationWorktreeOf(suiteDir, r, multi);
    if (existsSync(path.join(worktree, ".git"))) await cleanWorktree(worktree);
    else {
      await mkdir(path.dirname(worktree), { recursive: true });
      await addWorktree(r.root, worktree, branch);
    }
    worktrees.set(r.name, worktree);
  }
  await store.update((s) => {
    s.status = "integrating";
    s.integrationBranch = branch;
  });
  for (const r of state.repos) {
    if ((await integrateRepo(ctx, opts, r, worktrees.get(r.name)!)) === "failed") return "failed";
  }
  return "merged";
}

async function integrateRepo(ctx: IntegrateContext, opts: IntegrateOptions, r: SuiteRepo, worktree: string): Promise<"merged" | "failed"> {
  const { store, suiteDir, log } = ctx;
  const repo = r.root;
  const state = store.state;
  const signal = opts.signal ?? new AbortController().signal;
  const env = await checkEnvironment({ cwd: repo, provider: state.provider });
  const order = state.features
    .filter((f) => f.status === "done" && f.repo === r.name)
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  const changes = new Map<string, Promise<ChangesOf>>();
  const changesOf = (f: SuiteFeature): Promise<ChangesOf> => {
    let c = changes.get(f.name);
    if (!c) {
      c = readRunState(suiteDir, f).then((r) => rangeChanges(repo, r.startingCommit, r.branch));
      changes.set(f.name, c);
    }
    return c;
  };
  const specOf = async (f: SuiteFeature): Promise<FeatureSpec> => ({
    name: f.name,
    path: f.prd,
    text: await readFile(f.prd, "utf8"),
  });

  for (const f of order) {
    if (state.integration.merged.includes(f.name)) continue;
    const featureBranch = (await readRunState(suiteDir, f)).branch;
    const recordMerged = async (): Promise<void> => {
      await store.update((s) => {
        s.integration.merged.push(f.name);
        delete s.integration.failed;
      });
      log(`merged feature ${f.name}`);
    };
    if (await isAncestor(worktree, featureBranch, "HEAD")) {
      await recordMerged();
      continue;
    }
    const message = `Merge feature ${f.name}`;
    const result = await merge(worktree, featureBranch, message);
    if (!result.ok) {
      const specs = [await specOf(f)];
      for (const name of state.integration.merged) {
        const other = state.features.find((x) => x.name === name);
        if (!other || other.repo !== r.name) continue;
        const touched = new Set((await changesOf(other)).map((c) => c.path));
        if (result.conflicted.some((p) => touched.has(p))) specs.push(await specOf(other));
      }
      const attempts = env.config.attempts;
      const setAgent = (patch: Partial<IntegrationAgent>): Promise<void> =>
        store.update((s) => {
          const agents = (s.integration.agents ??= {});
          agents[f.name] = { ...(agents[f.name] ?? { files: result.conflicted, attempt: 1, attempts, status: "running" }), ...patch };
        });
      await setAgent({ files: result.conflicted, attempt: 1, attempts, status: "running" });
      // Its full output goes to logs/integration-<name>.log, like an agent's in a run (PRD §6).
      const output = new RunEmitter();
      const stopLogs = writeAgentLogs(output, path.join(suiteDir, "logs"));
      try {
        await resolveConflicts({
          provider: teeOutput(
            watchIdle(
              watchLoops(env.provider, env.config.loopDetection, (label, why) => log(`[${label}] stopped: ${why}; retrying`)),
              env.config.idleTimeoutMinutes,
              (label, why) => log(`[${label}] stopped: ${why}; retrying`),
            ),
            output,
          ),
          integrationWorktree: worktree,
          branch: featureBranch,
          files: result.conflicted,
          message,
          label: `integration-${f.name}`,
          step: `integration of ${f.name}`,
          hint: "graph-execution suite --resume",
          signal,
          attempts,
          model: state.model,
          log,
          specs,
          onAttempt: (attempt) => void setAgent({ attempt }),
        });
        await setAgent({ status: "resolved" });
      } catch (err) {
        if (!(err instanceof RetriesExhaustedError)) throw err;
        await setAgent({ status: "failed" });
        await store.update((s) => {
          s.integration.failed = f.name;
        });
        log(`integration of ${f.name} failed: ${err.message}`);
        return "failed";
      } finally {
        stopLogs();
      }
    }
    await recordMerged();
  }
  return "merged";
}
