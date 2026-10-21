import path from "node:path";
import { execa } from "execa";
import { rangeChanges, resolveRef, summarizeChanges, worktreeChanges } from "../git/git.js";
import type { NodeChanges } from "../runner/events.js";
import { AGENT_NODE } from "../runner/nodes.js";
import type { RunState } from "../state/state.js";
import { featureRunDir, type SuiteState } from "./state.js";

/**
 * Where a node of the suite page's graph changed code: a commit range in the repo, or a live worktree against its
 * base while the agent still works. Node keys are the page's: `<feature>/<task>`, `@fixer/<feature>`,
 * `@gate-fixer/<feature>`, `@merge/<feature>`, `@integration/<feature>`, `@e2e-fixer` and `@apply`. `only` limits a
 * range to some files: the integration agent's node shows its merge commit's conflicted files.
 */
export type ChangeSource =
  | { kind: "range"; repo: string; from: string; to: string; only?: string[] }
  | { kind: "live"; worktree: string; base: string; only?: string[] };

export interface SuiteChanges {
  sources: Map<string, ChangeSource>;
  /** Per merge node, the files both sides changed that git could not merge on its own (resolved by the integration agent). */
  conflicts: Record<string, string[]>;
}

const gitOut = async (cwd: string, args: string[]): Promise<string> => (await execa("git", ["--no-optional-locks", ...args], { cwd })).stdout;

/** The files git cannot merge between two commits, without touching any worktree. */
async function treeConflicts(repo: string, ours: string, theirs: string): Promise<string[]> {
  // `merge-tree --write-tree` exits 1 with the conflicted paths after the tree id; needs git 2.38+, else no conflicts shown.
  const r = await execa("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs], { cwd: repo, reject: false });
  return r.exitCode === 1 ? r.stdout.split("\n").slice(1).filter(Boolean) : [];
}

/** Merge commits never change, so their conflict check runs once. */
const conflictCache = new Map<string, Promise<string[]>>();
function mergeConflicts(repo: string, commit: string): Promise<string[]> {
  let c = conflictCache.get(commit);
  if (!c) {
    c = treeConflicts(repo, `${commit}^1`, `${commit}^2`);
    conflictCache.set(commit, c);
  }
  return c;
}

/** The change sources of every node that changes code, read from the suite and feature states and git. */
export async function suiteChangeSources(repo: string, suiteDir: string, suite: SuiteState, runs: Map<string, RunState>): Promise<SuiteChanges> {
  const sources = new Map<string, ChangeSource>();
  const conflicts: Record<string, string[]> = {};
  for (const f of suite.features) {
    const run = runs.get(f.name);
    if (!run) continue;
    for (const [id, t] of Object.entries(run.tasks)) {
      if (!t.baseSha) continue;
      if (t.status === "running" && t.worktree) sources.set(`${f.name}/${id}`, { kind: "live", worktree: t.worktree, base: t.baseSha });
      // A finished run deletes its task branches; the merge commit's second parent is the same tip.
      else if (t.mergeCommit) sources.set(`${f.name}/${id}`, { kind: "range", repo, from: t.baseSha, to: `${t.mergeCommit}^2` });
      else if (t.branch) sources.set(`${f.name}/${id}`, { kind: "range", repo, from: t.baseSha, to: t.branch });
    }
    const integration = path.join(featureRunDir(suiteDir, f.runId), "worktrees", "integration");
    for (const [node, key] of [
      [AGENT_NODE.fixer, `@fixer/${f.name}`],
      [AGENT_NODE.gateFixer, `@gate-fixer/${f.name}`],
    ] as const) {
      const range = run.fixRanges?.[node];
      if (!range) continue;
      sources.set(key, range.to ? { kind: "range", repo, from: range.from, to: range.to } : { kind: "live", worktree: integration, base: range.from });
    }
  }
  const head = suite.integrationBranch ? await resolveRef(repo, suite.integrationBranch) : undefined;
  if (!head) return { sources, conflicts };
  // The suite branch's own history: one merge commit per merged feature, whose second parent is that feature's
  // result branch (the message is the integration agent's when it resolved a conflict), then the e2e fixer's commits.
  const tips = new Map<string, string>();
  for (const name of suite.integration.merged) {
    const run = runs.get(name);
    const tip = run && (await resolveRef(repo, run.integrationBranch));
    if (tip) tips.set(tip, name);
  }
  const log = await gitOut(repo, ["log", "--first-parent", "--reverse", "--format=%H %P", `${suite.startingCommit}..${head}`]).catch(() => "");
  let lastMerge: string | undefined;
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, , second] = line.split(" ");
    const name = second && tips.get(second);
    if (!name) continue;
    sources.set(`@merge/${name}`, { kind: "range", repo, from: `${sha}^1`, to: sha! });
    conflicts[`@merge/${name}`] = await mergeConflicts(repo, sha!);
    const agent = suite.integration.agents?.[name];
    if (agent?.status === "resolved") sources.set(`@integration/${name}`, { kind: "range", repo, from: `${sha}^1`, to: sha!, only: agent.files });
    lastMerge = sha;
  }
  // A merge the integration agent gave up on: the files git cannot merge between the suite branch and the feature.
  const failed = suite.integration.failed;
  const failedRun = failed ? runs.get(failed) : undefined;
  if (failed && failedRun) conflicts[`@merge/${failed}`] = await treeConflicts(repo, head, failedRun.integrationBranch);
  if (lastMerge && suite.review && lastMerge !== head) sources.set("@e2e-fixer", { kind: "range", repo, from: lastMerge, to: head });
  if (suite.review?.phase === "done" || suite.status === "applied" || suite.status === "done") {
    sources.set("@apply", { kind: "range", repo, from: suite.startingCommit, to: head });
  }
  return { sources, conflicts };
}

/** Finished ranges are immutable once their ends are resolved to commits, so their stats are cached by commit pair. */
const rangeCache = new Map<string, Promise<NodeChanges>>();
export async function changesOf(source: ChangeSource): Promise<NodeChanges | undefined> {
  const all = await allChangesOf(source);
  return all && source.only ? summarizeChanges(all.files.filter((f) => source.only!.includes(f.path))) : all;
}

async function allChangesOf(source: ChangeSource): Promise<NodeChanges | undefined> {
  try {
    if (source.kind === "live") return summarizeChanges(await worktreeChanges(source.worktree, source.base));
    const [from, to] = await Promise.all([resolveRef(source.repo, source.from), resolveRef(source.repo, source.to)]);
    if (!from || !to) return undefined;
    const key = `${from}..${to}`;
    let c = rangeCache.get(key);
    if (!c) {
      c = rangeChanges(source.repo, from, to).then(summarizeChanges);
      rangeCache.set(key, c);
      c.catch(() => rangeCache.delete(key));
    }
    return await c;
  } catch {
    // A worktree removed between the read and the diff: no stats this time.
    return undefined;
  }
}
