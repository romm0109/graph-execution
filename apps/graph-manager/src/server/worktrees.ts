// Git worktrees of graph-manager (docs/prd/done/isolated-workspaces.md): every terminal opened on a workspace works in its
// own worktree and branch, and Create PR commits in a throwaway one, so nothing ever changes the workspace checkout.
// They live in `<workspace>/.gm-worktrees/`: inside the workspace, so a sandbox's workspace mount sees them, and never
// inside `.graph-execution/`, where the engine refuses to run.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AppContext } from "./app.js";
import { clientFor, connFor } from "./forges.js";
import type { Workspace } from "./workspaces.js";

export const WORKTREES_DIR = ".gm-worktrees";
/** The branch prefix of terminal worktrees; cannot clash with the engine's `graph/` and `graph-task/`. */
export const TERMINAL_BRANCH_PREFIX = "gm-term/";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[], opts: { timeout?: number } = {}): Promise<GitResult> {
  const res = await execa("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    reject: false,
    stdin: "ignore",
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  });
  const stderr = String(res.stderr ?? "").trim();
  return { ok: res.exitCode === 0 && !res.timedOut, stdout: String(res.stdout ?? "").trim(), stderr: res.timedOut && stderr === "" ? "timed out" : stderr };
}

/** A git failure with the HTTP status a route answers with. */
export class WorktreeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** The branch checked out in `cwd`, or undefined on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const res = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return res.ok && res.stdout !== "" ? res.stdout : undefined;
}

/** The last line of a git error, for a message. */
export const lastLine = (text: string): string => text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

/** Whether the repository at `cwd` has an `origin` remote. */
export const hasOrigin = async (cwd: string): Promise<boolean> => (await git(cwd, ["remote", "get-url", "origin"])).ok;

/**
 * The workspace's default base branch for a new terminal: origin's HEAD branch, else the forge's default branch (when
 * connected), else the checkout's current branch.
 */
export async function defaultBaseBranch(ctx: AppContext, ws: Workspace): Promise<string | undefined> {
  const head = await git(ws.path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.startsWith("origin/") && head.stdout.length > "origin/".length) return head.stdout.slice("origin/".length);
  if ((ws.forge === "github" || ws.forge === "gitlab") && connFor(ctx, ws.forge)) {
    try {
      const b = (await clientFor(ctx, ws.forge).getRepo(ws.fullPath)).defaultBranch;
      if (b) return b;
    } catch {
      // fall back to the current branch
    }
  }
  return currentBranch(ws.path);
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
  /** The branch it was cut from (or the workspace's branch at that time), the default target of a PR. */
  baseBranch?: string;
  /** Set when the remote base could not be fetched and the local branch was used. */
  warning?: string;
}

/**
 * A worktree for a terminal: `<workspace>/.gm-worktrees/<id>` on a new branch `gm-term/<id>`. Without `baseBranch` it is
 * cut from the workspace's HEAD; with it, from freshly fetched `origin/<baseBranch>`, else the local branch (with a
 * `warning`). Undefined when the workspace has no commit yet (a worktree needs one) or git fails. Throws
 * `WorktreeError(400)` when `baseBranch` exists neither on origin nor locally.
 */
export async function addTerminalWorktree(wsPath: string, opts: { id?: string; baseBranch?: string } = {}): Promise<TerminalWorktree | undefined> {
  const id = opts.id ?? newWorktreeId();
  const head = await git(wsPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok || head.stdout === "") return undefined;
  let commit = head.stdout;
  let baseBranch: string | undefined;
  let warning: string | undefined;
  const b = opts.baseBranch;
  if (b === undefined) {
    baseBranch = await currentBranch(wsPath);
  } else {
    if (b.startsWith("-") || b === "") throw new WorktreeError(400, `branch ${b} not found`);
    const resolve = async (ref: string) => {
      const r = await git(wsPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return r.ok && r.stdout !== "" ? r.stdout : undefined;
    };
    let remote: string | undefined;
    let why: string;
    if (await hasOrigin(wsPath)) {
      const fetch = await git(wsPath, ["fetch", "-q", "origin", b], { timeout: 30_000 });
      if (fetch.ok) {
        // `git fetch origin <b>` updates `refs/remotes/origin/<b>` through the default refspec.
        remote = await resolve(`refs/remotes/origin/${b}`);
        why = `could not fetch origin/${b}: not on origin; started from local ${b}`;
      } else {
        why = `could not fetch origin/${b}: ${lastLine(fetch.stderr) || "not on origin"}; started from local ${b}`;
      }
    } else {
      why = `no origin remote; started from local ${b}`;
    }
    if (remote) {
      commit = remote;
    } else {
      const local = await resolve(`refs/heads/${b}`);
      if (!local) throw new WorktreeError(400, `branch ${b} not found`);
      commit = local;
      warning = why;
    }
    baseBranch = b;
  }
  await ensureExcluded(wsPath);
  const dir = path.join(wsPath, WORKTREES_DIR, id);
  const branch = `${TERMINAL_BRANCH_PREFIX}${id}`;
  const add = await git(wsPath, ["worktree", "add", "-q", "-b", branch, dir, commit]);
  if (!add.ok) return undefined;
  return { id, path: dir, branch, base: commit, ...(baseBranch ? { baseBranch } : {}), ...(warning ? { warning } : {}) };
}

/** Branch prefixes of graph-manager and the engine, left out of the base branch picker. */
const TOOL_BRANCH_PREFIXES = [TERMINAL_BRANCH_PREFIX, "graph/", "graph-task/", "gm/"];

export interface BaseBranches {
  branches: string[];
  default?: string;
  current?: string;
  fetched: boolean;
  error?: string;
  noCommit?: boolean;
}

/**
 * The branches a terminal can start from: origin's branches, then local branches without an origin counterpart (not
 * graph-manager's or the engine's own), the default one first. `fetch` runs `git fetch --prune origin` first.
 */
export async function baseBranches(ctx: AppContext, ws: Workspace, fetch: boolean): Promise<BaseBranches> {
  const head = await git(ws.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok || head.stdout === "") return { branches: [], noCommit: true, fetched: false };
  let fetched = false;
  let error: string | undefined;
  if (fetch) {
    if (await hasOrigin(ws.path)) {
      const res = await git(ws.path, ["fetch", "-q", "--prune", "origin"], { timeout: 15_000 });
      fetched = res.ok;
      if (!res.ok) error = lastLine(res.stderr) || "git fetch failed";
    } else {
      error = "no origin remote";
    }
  }
  const refs = await git(ws.path, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
  const local: string[] = [];
  const remote: string[] = [];
  if (refs.ok) {
    for (const ref of refs.stdout.split("\n")) {
      if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
      else if (ref.startsWith("refs/remotes/origin/") && ref !== "refs/remotes/origin/HEAD") remote.push(ref.slice("refs/remotes/origin/".length));
    }
  }
  const onOrigin = new Set(remote);
  const extra = local.filter((n) => !onOrigin.has(n) && !TOOL_BRANCH_PREFIXES.some((p) => n.startsWith(p)));
  const def = await defaultBaseBranch(ctx, ws);
  const current = await currentBranch(ws.path);
  const list = [...remote.sort(), ...extra.sort()];
  const branches = def ? [def, ...list.filter((n) => n !== def)] : list;
  return { branches, ...(def ? { default: def } : {}), ...(current ? { current } : {}), fetched, ...(error ? { error } : {}) };
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
