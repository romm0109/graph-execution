import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  addWorktree,
  cleanWorktree,
  deleteBranchIfPresent,
  findMergeOf,
  isAncestor,
  pruneWorktrees,
  removeWorktreeIfPresent,
  resolveRef,
} from "../git/git.js";
import { initialReviewState, type RunState } from "./state.js";

/** `<repo>/.graph-execution`; mirrors `RUNS_DIR` of the runner. */
const runsDir = (repo: string): string => path.join(repo, ".graph-execution");

export const runDirOf = (repo: string, runId: string): string => path.join(runsDir(repo), runId);

/** The run to resume: `runId` when given, else the latest run (run ids sort by time). */
export async function findRun(repo: string, runId?: string): Promise<string> {
  if (runId !== undefined) {
    const dir = runDirOf(repo, runId);
    if (!existsSync(path.join(dir, "state.json"))) throw new Error(`no run ${runId} to resume in ${runsDir(repo)}`);
    return dir;
  }
  const ids = (await readdir(runsDir(repo)).catch(() => []))
    .filter((id) => existsSync(path.join(runDirOf(repo, id), "state.json")))
    .sort();
  if (ids.length === 0) throw new Error(`no run to resume in ${runsDir(repo)}`);
  return runDirOf(repo, ids.at(-1)!);
}

/**
 * Repairs the saved state of an interrupted run against git, which wins (PRD §6, §7.8):
 * - every worktree but the integration one is removed (task worktrees and leftover `review-*` ones), and the
 *   integration worktree is cleaned of any half-done merge or uncommitted change, or re-added when missing;
 * - `merged` tasks whose merge commit is not on the integration branch go back to `pending`;
 * - `merging` tasks whose branch tip is on the integration branch are `merged`; the others keep `merging` so the
 *   runner retries only the merge (or go back to `pending` when their branch is gone);
 * - `running` and `validating` tasks lose their branch and go back to `pending`, keeping their attempt counter;
 * - `failed` tasks go back to `pending` with a fresh attempt counter;
 * - when a merge was lost, the review phase and its reports are dropped: it reviewed a tree that is gone.
 * Mutates and returns `state`.
 */
export async function reconcile(state: RunState, repo: string): Promise<RunState> {
  const runDir = runDirOf(repo, state.runId);
  const worktreesDir = path.join(runDir, "worktrees");
  const integrationWorktree = path.join(worktreesDir, "integration");
  const integration = state.integrationBranch;

  if (!(await resolveRef(repo, integration))) {
    throw new Error(`cannot resume: the integration branch ${integration} no longer exists`);
  }
  await pruneWorktrees(repo);
  for (const name of await readdir(worktreesDir).catch(() => [])) {
    if (name !== "integration") await removeWorktreeIfPresent(repo, path.join(worktreesDir, name));
  }
  if (existsSync(path.join(integrationWorktree, ".git"))) await cleanWorktree(integrationWorktree);
  else {
    await removeWorktreeIfPresent(repo, integrationWorktree);
    await addWorktree(repo, integrationWorktree, integration);
  }

  let lostMerge = false;
  for (const task of Object.values(state.tasks)) {
    delete task.worktree;
    switch (task.status) {
      case "merged":
        if (!task.mergeCommit || !(await isAncestor(repo, task.mergeCommit, integration))) {
          Object.assign(task, { status: "pending", attempts: 0 });
          delete task.mergeCommit;
          lostMerge = true;
        }
        break;
      case "merging": {
        const tip = task.branch && (await resolveRef(repo, task.branch));
        if (!tip) task.status = "pending";
        else if (await isAncestor(repo, tip, integration)) {
          task.status = "merged";
          task.mergeCommit = (await findMergeOf(repo, integration, tip)) ?? (await resolveRef(repo, integration));
        }
        break;
      }
      case "running":
      case "validating":
        if (task.branch) await deleteBranchIfPresent(repo, task.branch);
        task.status = "pending";
        break;
      case "failed":
        if (task.branch) await deleteBranchIfPresent(repo, task.branch);
        Object.assign(task, { status: "pending", attempts: 0 });
        break;
      case "pending":
        break;
    }
  }
  // Reviews of a tree that lost a merge are stale: the review phase starts over once the task is merged again.
  if (lostMerge && state.review.phase !== "validate") {
    state.review = initialReviewState();
    await rm(path.join(runDir, "reports"), { recursive: true, force: true });
  }
  return state;
}
