import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { ChangedFile, NodeChanges } from "../runner/events.js";

const git = async (cwd: string, args: string[]): Promise<string> => (await execa("git", args, { cwd })).stdout.trim();

export async function isRepo(cwd: string): Promise<boolean> {
  const res = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

export const repoRoot = (cwd: string): Promise<string> => git(cwd, ["rev-parse", "--show-toplevel"]);

export const currentHead = (cwd: string): Promise<string> => git(cwd, ["rev-parse", "HEAD"]);

/** Name of the checked-out branch, or `HEAD` when detached. */
export const currentBranch = (cwd: string): Promise<string> => git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

/** True when the working tree has uncommitted changes, not counting the `ignore` paths (relative to `cwd`). */
export async function isDirty(cwd: string, ignore: readonly string[] = []): Promise<boolean> {
  if (ignore.length === 0) return (await git(cwd, ["status", "--porcelain"])) !== "";
  // Every untracked file on its own line: a collapsed `?? dir/` would not match an excluded path inside it.
  const pathspec = ["--", ".", ...ignore.map((p) => `:(exclude)${p}`)];
  return (await git(cwd, ["status", "--porcelain", "--untracked-files=all", ...pathspec])) !== "";
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

/**
 * Removes the worktree at `worktreePath` if it exists, even when git no longer has it registered or cannot delete it
 * (e.g. paths over 260 characters on Windows without `core.longpaths`): what git leaves is deleted with `fs.rm`.
 */
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

/** NUL-separated git output (`-z`) as a list. */
const lines0 = (out: string): string[] => out.split("\0").filter(Boolean);

/** Files with uncommitted changes in `worktree`: modified or deleted tracked files and untracked ones (not ignored). */
export async function dirtyPaths(worktree: string): Promise<string[]> {
  const tracked = lines0(await git(worktree, ["diff", "--name-only", "-z", "HEAD"]));
  const untracked = lines0(await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])];
}

/**
 * Commits whatever an agent left uncommitted in `worktree` (tracked changes and new files; ignored files stay out),
 * so a finished agent's work is never lost to a forgotten or partial `git commit`. `preexisting` are the paths that
 * were already dirty when the agent started, e.g. output of `setup` or of a validation command: they are left out.
 * Hooks are skipped: the agent's own commits ran them, and a hook failing here would only turn finished work into a
 * failed attempt. True when it committed something.
 */
export async function commitLeftovers(worktree: string, message: string, preexisting: readonly string[] = []): Promise<boolean> {
  const skip = new Set(preexisting);
  const paths = (await dirtyPaths(worktree)).filter((p) => !skip.has(p));
  if (paths.length === 0) return false;
  await git(worktree, ["add", "-A", "--", ...paths.map((p) => `:(literal)${p}`)]);
  await git(worktree, ["commit", "-q", "--no-verify", "-m", message]);
  return true;
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

export interface ChangedPath {
  path: string;
  added: number;
  deleted: number;
  /** A file the change creates. */
  isNew?: boolean;
}

export type ApplyResult =
  | {
      ok: true;
      /** What the run changed, not the user's own edits; conflicted files are listed in `conflicts` instead. */
      files: ChangedPath[];
      /** Files left with conflict markers and unmerged in the index, for the user's editor to resolve. */
      conflicts: string[];
      /** The stash commit holding the user's uncommitted changes from before the apply; absent when there were none. */
      backup?: string;
    }
  | { ok: false; reason: string };

/**
 * Brings the changes of `branch` into `target`, the branch checked out in the main checkout at `repo`, as uncommitted
 * changes for the user to review and commit: a three-way squash merge, then everything unstaged. New files are left
 * untracked, like any file the user creates, so an editor's "discard" deletes them. (Intent-to-add would show them
 * in `git diff`, but discarding one in an editor then empties it instead.) Git's `SQUASH_MSG` is kept as the commit
 * message. Returns the changed files, new ones marked.
 *
 * Uncommitted changes to tracked files don't stop it. They are saved with `git stash create`, kept in the stash list
 * as a backup, the checkout is reset, the squash merge is done, and the user's changes are applied back on top.
 * Where they overlap the run's, and where the run overlaps commits made on `target` since it started, the files are
 * left as merge conflicts (markers, unmerged in the index) instead of failing. Both at once can't be stacked: when
 * the squash itself conflicts and there were local changes, the checkout is put back exactly as it was.
 * Refuses when `target` is no longer checked out. Untracked files are never touched: git refuses up front to
 * overwrite one, and the checkout is then restored.
 */
export async function applyToCheckout(repo: string, target: string, branch: string): Promise<ApplyResult> {
  const current = await currentBranch(repo);
  if (current !== target) return { ok: false, reason: `the checkout is on ${current}, not on ${target} where the run started` };
  const dirty = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])) !== "";
  const backup = dirty ? await git(repo, ["stash", "create"]) : undefined;
  if (backup) {
    await git(repo, ["stash", "store", "-m", `graph-execution: your changes before applying ${branch}`, backup]);
    await git(repo, ["reset", "-q", "--hard", "HEAD"]);
  }
  /** Puts the checkout back as it was before the apply: nothing of the run, the user's changes staged as before. */
  const restore = async (): Promise<void> => {
    await execa("git", ["reset", "-q", "--hard", "HEAD"], { cwd: repo, reject: false });
    if (backup) await execa("git", ["stash", "apply", "-q", "--index", backup], { cwd: repo, reject: false });
  };
  const failed = (what: string, res: { stderr: string; stdout: string; exitCode?: number }): ApplyResult => {
    const detail = `${res.stderr}\n${res.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: false, reason: `${what}: ${detail.slice(0, 3).join(" ") || `exit code ${res.exitCode}`}` };
  };
  const unmerged = async (): Promise<string[]> => lines0(await git(repo, ["diff", "--name-only", "--diff-filter=U", "-z"]));

  const res = await execa("git", ["merge", "--squash", "--no-commit", branch], { cwd: repo, reject: false });
  let conflicts = res.exitCode === 0 ? [] : await unmerged();
  if (res.exitCode !== 0 && (conflicts.length === 0 || backup)) {
    await restore();
    if (conflicts.length === 0) return failed("git merge failed and was rolled back", res);
    return {
      ok: false,
      reason:
        `${branch} conflicts with commits made on ${target} since the run started (${conflicts.join(", ")}), ` +
        `and ${target} also had uncommitted changes, which were left as they were; commit or stash them and merge ` +
        `it yourself: git merge --squash --no-commit ${branch}`,
    };
  }
  // Read while the run's changes are all that is staged: afterwards new files are untracked and out of `git diff`.
  const added = new Set(lines0(await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=A", "-z"])));
  const changed = parseNumstat(await git(repo, ["diff", "--cached", "--numstat"])).map((f) =>
    added.has(f.path) ? { ...f, isNew: true } : f,
  );
  // `git reset` and `git stash apply` may drop the squash message; it is put back for the user's `git commit`.
  const squashMsg = path.resolve(repo, await git(repo, ["rev-parse", "--git-path", "SQUASH_MSG"]));
  const message = existsSync(squashMsg) ? await readFile(squashMsg, "utf8") : undefined;
  if (backup) {
    const applied = await execa("git", ["stash", "apply", backup], { cwd: repo, reject: false });
    conflicts = await unmerged();
    if (applied.exitCode !== 0 && conflicts.length === 0) {
      await restore();
      return failed("your uncommitted changes could not be applied back on top of the result, so nothing was applied", applied);
    }
  }
  // Unstage everything but the conflicts, which stay unmerged so an editor shows them as merge conflicts.
  const staged = lines0(await git(repo, ["diff", "--cached", "--name-only", "-z"])).filter((f) => !conflicts.includes(f));
  if (conflicts.length === 0) await git(repo, ["reset", "-q"]);
  else if (staged.length > 0) await git(repo, ["reset", "-q", "--", ...staged]);
  if (message !== undefined) await writeFile(squashMsg, message);
  const files = changed.filter((f) => !conflicts.includes(f.path));
  return { ok: true, files, conflicts, ...(backup ? { backup } : {}) };
}

/** Runs a read-only git command for the live change view: no optional locks, raw (untrimmed) stdout. */
const gitRead = async (cwd: string, args: string[]): Promise<string> =>
  (await execa("git", ["--no-optional-locks", ...args], { cwd })).stdout;

/** `git diff --numstat -z --no-renames` output: `added\tdeleted\tpath\0` records; `-\t-` is binary. */
function parseNumstatZ(out: string): ChangedFile[] {
  return lines0(out).map((rec) => {
    const [added, deleted, ...rest] = rec.split("\t");
    const binary = added === "-" && deleted === "-";
    return { path: rest.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0, ...(binary ? { binary } : {}) };
  });
}

/** Line count of a text file's content: `\n` count, plus one for an unterminated last line. */
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** `numstat` and `name-status` output (both `-z`) of one diff as files keyed by path. */
function combineDiff(numstat: string, nameStatus: string): Map<string, ChangedFile> {
  const status = new Map<string, string>();
  const parts = lines0(nameStatus);
  for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1]!, parts[i]!);
  const files = new Map<string, ChangedFile>();
  for (const f of parseNumstatZ(numstat)) {
    const s = status.get(f.path);
    files.set(f.path, { ...f, ...(s === "A" ? { isNew: true } : {}), ...(s === "D" ? { isDeleted: true } : {}) });
  }
  return files;
}

const byPath = (a: ChangedFile, b: ChangedFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What commit `to` changed against `from`, sorted by path; the same shape as `worktreeChanges`, without untracked files. */
export async function rangeChanges(repo: string, from: string, to: string): Promise<ChangedFile[]> {
  const [numstat, nameStatus] = await Promise.all([
    gitRead(repo, ["diff", "--no-renames", "--numstat", "-z", from, to]),
    gitRead(repo, ["diff", "--no-renames", "--name-status", "-z", from, to]),
  ]);
  return [...combineDiff(numstat, nameStatus).values()].sort(byPath);
}

/** The unified diff of one file between two commits. */
export async function rangeFileDiff(repo: string, from: string, to: string, file: string): Promise<string> {
  return gitRead(repo, ["diff", "--no-renames", from, to, "--", file]);
}

const COUNT_LINES_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What `worktree` changed against `base`: its commits, uncommitted tracked changes and untracked files (not ignored),
 * minus the `exclude` paths, sorted by path. Read-only: nothing is staged and no index lock is taken.
 */
export async function worktreeChanges(worktree: string, base: string, exclude: readonly string[] = []): Promise<ChangedFile[]> {
  const [numstat, nameStatus, untracked] = await Promise.all([
    gitRead(worktree, ["diff", "--no-renames", "--numstat", "-z", base]),
    gitRead(worktree, ["diff", "--no-renames", "--name-status", "-z", base]),
    gitRead(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = combineDiff(numstat, nameStatus);
  for (const rel of lines0(untracked)) {
    if (files.has(rel)) continue;
    try {
      const abs = path.join(worktree, rel);
      // A huge untracked file is listed but not read on every poll.
      if ((await stat(abs)).size > COUNT_LINES_MAX_BYTES) {
        files.set(rel, { path: rel, added: 0, deleted: 0, isNew: true });
        continue;
      }
      const buf = await readFile(abs);
      const binary = buf.subarray(0, 8000).includes(0);
      files.set(rel, { path: rel, added: binary ? 0 : countLines(buf), deleted: 0, isNew: true, ...(binary ? { binary } : {}) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EISDIR") throw err;
    }
  }
  for (const p of exclude) files.delete(p);
  return [...files.values()].sort(byPath);
}

/** The files with their totals. */
export function summarizeChanges(files: ChangedFile[]): NodeChanges {
  return {
    files,
    total: {
      added: files.reduce((n, f) => n + f.added, 0),
      deleted: files.reduce((n, f) => n + f.deleted, 0),
      files: files.length,
    },
  };
}

/** `git diff --numstat` output as files with line counts (0 for binary files). */
function parseNumstat(out: string): ChangedPath[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split("\t");
      return { path: rest.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
}

/** The non-merge commits in `from..to`, oldest first, as `<short sha> <subject>`. */
export async function commitLines(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await git(cwd, ["log", "--no-merges", "--reverse", "--format=%h %s", `${from}..${to}`]);
  return out.split("\n").filter(Boolean);
}
