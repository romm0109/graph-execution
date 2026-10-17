import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const git = async (cwd: string, args: string[]): Promise<string> => (await execa("git", args, { cwd })).stdout.trim();

export async function isRepo(cwd: string): Promise<boolean> {
  const res = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

export const repoRoot = (cwd: string): Promise<string> => git(cwd, ["rev-parse", "--show-toplevel"]);

export const currentHead = (cwd: string): Promise<string> => git(cwd, ["rev-parse", "HEAD"]);

/** Name of the checked-out branch, or `HEAD` when detached. */
export const currentBranch = (cwd: string): Promise<string> => git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])) !== "";
}

export async function createBranch(repo: string, base: string, name: string): Promise<void> {
  await git(repo, ["branch", name, base]);
}

/**
 * Adds a worktree at `worktreePath` with `branch` checked out. With `base`, the branch is (re)created at it,
 * discarding any commits a previous attempt left on it.
 * A branch can only be checked out in one worktree, so the integration branch lives only in its own worktree.
 */
export async function addWorktree(repo: string, worktreePath: string, branch: string, base?: string): Promise<void> {
  const args = base ? ["worktree", "add", "-B", branch, worktreePath, base] : ["worktree", "add", worktreePath, branch];
  await git(repo, args);
}

export async function addDetachedWorktree(repo: string, worktreePath: string, ref: string): Promise<void> {
  await git(repo, ["worktree", "add", "--detach", worktreePath, ref]);
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktreePath]);
}

/** Removes the worktree at `worktreePath` if it exists, even when git no longer has it registered. */
export async function removeWorktreeIfPresent(repo: string, worktreePath: string): Promise<void> {
  if (existsSync(worktreePath)) {
    await execa("git", ["worktree", "remove", "--force", worktreePath], { cwd: repo, reject: false });
    await rm(worktreePath, { recursive: true, force: true });
  }
  await git(repo, ["worktree", "prune"]);
}

/** True when HEAD of `worktree` has at least one commit that `sinceSha` does not. */
export async function hasNewCommit(worktree: string, sinceSha: string): Promise<boolean> {
  return Number(await git(worktree, ["rev-list", "--count", `${sinceSha}..HEAD`])) > 0;
}

/** Moves `worktree` back to `sha`, dropping commits and tracked or untracked changes made since (ignored files stay). */
export async function resetHard(worktree: string, sha: string): Promise<void> {
  await git(worktree, ["reset", "--hard", sha]);
  await git(worktree, ["clean", "-fd"]);
}

export type MergeResult ={ ok: true } | { ok: false; conflicted: string[] };

/**
 * Merges `branch` into the branch checked out in `worktree`, always creating a merge commit (`--no-ff`).
 * On conflict the worktree is left in the conflicted state for the resolver.
 */
export async function merge(worktree: string, branch: string, message = `Merge ${branch}`): Promise<MergeResult> {
  const res = await execa("git", ["merge", "--no-ff", "--no-edit", "-m", message, branch], { cwd: worktree, reject: false });
  if (res.exitCode === 0) return { ok: true };
  const conflicted = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
  if (conflicted.length === 0) throw new Error(`git merge ${branch} failed: ${res.stderr || res.stdout}`);
  return { ok: false, conflicted };
}

/** Appends `pattern` to the repo's `.git/info/exclude` unless it is already listed. Idempotent. */
export async function ensureExcluded(repo: string, pattern: string): Promise<void> {
  const file = path.resolve(repo, await git(repo, ["rev-parse", "--git-path", "info/exclude"]));
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    await mkdir(path.dirname(file), { recursive: true });
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${prefix}${pattern}\n`);
}

/** True when `ancestor` is reachable from `ref` (a commit is its own ancestor). */
export async function isAncestor(cwd: string, ancestor: string, ref: string): Promise<boolean> {
  const res = await execa("git", ["merge-base", "--is-ancestor", ancestor, ref], { cwd, reject: false });
  return res.exitCode === 0;
}

/** The commit `ref` points to, or `undefined` when it does not exist. */
export async function resolveRef(cwd: string, ref: string): Promise<string | undefined> {
  const res = await execa("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, reject: false });
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

export async function deleteBranchIfPresent(repo: string, branch: string): Promise<void> {
  await execa("git", ["branch", "-D", branch], { cwd: repo, reject: false });
}

/** The first-parent merge commit of `ref` whose merged-in parent is `tip`, if any. */
export async function findMergeOf(cwd: string, ref: string, tip: string): Promise<string | undefined> {
  const lines = (await git(cwd, ["log", "--first-parent", "--merges", "--format=%H %P", ref])).split("\n");
  return lines.map((l) => l.split(" ")).find((parts) => parts.slice(2).includes(tip))?.[0];
}

/** Drops an in-progress merge and every uncommitted change in `worktree` (ignored files stay). */
export async function cleanWorktree(worktree: string): Promise<void> {
  await execa("git", ["merge", "--abort"], { cwd: worktree, reject: false });
  await resetHard(worktree, "HEAD");
}

/** Forgets worktrees whose directory is gone. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}
