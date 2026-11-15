// Git worktrees of graph-manager (docs/prd/done/isolated-workspaces.md): every terminal opened on a workspace works in its
// own worktree and branch, and Create PR commits in a throwaway one, so nothing ever changes the workspace checkout.
// They live in `<workspace>/.gm-worktrees/`: inside the workspace, so a sandbox's workspace mount sees them, and never
// inside `.graph-execution/`, where the engine refuses to run.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export const WORKTREES_DIR = ".gm-worktrees";
/** The branch prefix of terminal worktrees; cannot clash with the engine's `graph/` and `graph-task/`. */
export const TERMINAL_BRANCH_PREFIX = "gm-term/";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const res = await execa("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, reject: false, stdin: "ignore" });
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

/** A new worktree id: `w` and 8 hex digits, unique across server restarts (terminal ids are not). */
export const newWorktreeId = (): string => `w${randomBytes(4).toString("hex")}`;

/** Adds `.gm-worktrees/` to the repository's `info/exclude` once, so worktrees never show as untracked files. */
export async function ensureExcluded(wsPath: string): Promise<void> {
  const res = await git(wsPath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!res.ok || res.stdout === "") return;
  const file = path.resolve(wsPath, res.stdout);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    // no exclude file yet
  }
  const line = `/${WORKTREES_DIR}/`;
  if (text.split(/\r?\n/).includes(line)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
}

export interface TerminalWorktree {
  id: string;
  path: string;
  branch: string;
  /** The commit the branch was cut from: work is anything after it, or uncommitted. */
  base: string;
  /** The workspace's branch at that time, the default target of a PR. */
  baseBranch?: string;
}

/**
 * A worktree for a terminal: `<workspace>/.gm-worktrees/<id>` on a new branch `gm-term/<id>`, cut from the workspace's
 * HEAD. Undefined when the workspace has no commit yet (a worktree needs one) or git fails.
 */
export async function addTerminalWorktree(wsPath: string, id = newWorktreeId()): Promise<TerminalWorktree | undefined> {
  const head = await git(wsPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok || head.stdout === "") return undefined;
  await ensureExcluded(wsPath);
  const dir = path.join(wsPath, WORKTREES_DIR, id);
  const branch = `${TERMINAL_BRANCH_PREFIX}${id}`;
  const add = await git(wsPath, ["worktree", "add", "-q", "-b", branch, dir, head.stdout]);
  if (!add.ok) return undefined;
  const cur = await git(wsPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { id, path: dir, branch, base: head.stdout, ...(cur.ok && cur.stdout !== "" ? { baseBranch: cur.stdout } : {}) };
}

export interface WorktreeState {
  /** Uncommitted changes (untracked files included). */
  dirty: number;
  /** Commits on the worktree's HEAD after `base`. */
  ahead: number;
}

/** What a worktree holds beyond `base`; a missing worktree holds nothing. */
export async function worktreeState(dir: string, base: string): Promise<WorktreeState> {
  const status = await git(dir, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout !== "" ? status.stdout.split("\n").length : 0;
  const count = await git(dir, ["rev-list", "--count", `${base}..HEAD`]);
  const ahead = count.ok ? Number(count.stdout) || 0 : 0;
  return { dirty, ahead };
}

export const hasWork = (s: WorktreeState): boolean => s.dirty > 0 || s.ahead > 0;

/** The changed paths of a worktree (`git status --porcelain`), relative to it, with `/` separators. */
export async function changedPaths(dir: string): Promise<string[]> {
  const status = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok || status.stdout === "") return [];
  return status.stdout.split("\n").map((l) => {
    const p = l.slice(3);
    const arrow = p.indexOf(" -> ");
    return (arrow === -1 ? p : p.slice(arrow + 4)).replace(/^"|"$/g, "");
  });
}

/** Removes a worktree (with any uncommitted changes) and, when given, its branch. Missing pieces are fine. */
export async function removeWorktree(wsPath: string, dir: string, deleteBranch?: string): Promise<void> {
  const res = await git(wsPath, ["worktree", "remove", "--force", dir]);
  if (!res.ok) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await git(wsPath, ["worktree", "prune"]);
  if (deleteBranch) await git(wsPath, ["branch", "-D", deleteBranch]);
}

/** Whether a worktree other than the workspace itself has `branch` checked out; git refuses a second one. */
export async function branchCheckedOut(wsPath: string, branch: string): Promise<string | undefined> {
  const res = await git(wsPath, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return undefined;
  let current: string | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return undefined;
}

/**
 * A throwaway worktree of `ref` (detached) at `.gm-worktrees/<name>`, for a commit that must not touch the checkout.
 * `dispose` removes it.
 */
export async function tempWorktree(wsPath: string, ref: string, name: string): Promise<{ path: string; dispose(): Promise<void> }> {
  await ensureExcluded(wsPath);
  const dir = path.join(wsPath, WORKTREES_DIR, name);
  await removeWorktree(wsPath, dir);
  await mkdir(path.dirname(dir), { recursive: true });
  const add = await git(wsPath, ["worktree", "add", "-q", "--detach", dir, ref]);
  if (!add.ok) throw new Error(add.stderr.split("\n").pop() || `git worktree add failed for ${ref}`);
  return { path: dir, dispose: () => removeWorktree(wsPath, dir) };
}
