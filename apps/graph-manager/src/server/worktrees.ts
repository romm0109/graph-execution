// Git worktrees of graph-manager (docs/prd/done/isolated-workspaces.md): every terminal opened on a workspace works in its
// own worktree and branch, and Create PR commits in a throwaway one, so nothing ever changes the workspace checkout.
// They live in `<workspace>/.gm-worktrees/`: inside the workspace, so a sandbox's workspace mount sees them, and never
// inside `.graph-execution/`, where the engine refuses to run.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AppContext } from "./app.js";
import { clientFor, connFor } from "./forges.js";
import { LINK_TYPE } from "./projects.js";
import type { ProjectWorktreeRecord } from "./store.js";
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

/**
 * The reason in a git error, for a message: its first `fatal:` or `error:` line, else its first line. (A failed fetch
 * ends with "…and the repository exists.", which says nothing on its own.)
 */
export const gitReason = (text: string): string => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? "").replace(/^(fatal|error):\s*/i, "");
};

/** Whether the repository at `cwd` has an `origin` remote. */
export const hasOrigin = async (cwd: string): Promise<boolean> => (await git(cwd, ["remote", "get-url", "origin"])).ok;

/**
 * The workspace's default base branch for a new terminal: origin's HEAD branch, else the forge's default branch (when
 * connected), else the checkout's current branch.
 */
export async function defaultBaseBranch(ctx: AppContext, ws: Workspace, opts: { network?: boolean } = {}): Promise<string | undefined> {
  const head = await git(ws.path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.startsWith("origin/") && head.stdout.length > "origin/".length) return head.stdout.slice("origin/".length);
  if ((ws.forge === "github" || ws.forge === "gitlab") && connFor(ctx, ws.forge)) {
    const key = `${ws.forge}:${ws.fullPath}`;
    const cached = forgeDefaultBranch.get(key);
    if (cached) return cached;
    // `network: false` (a branch list answered from local refs): no forge call, so that answer never waits on it.
    if (opts.network !== false) {
      try {
        const b = (await clientFor(ctx, ws.forge).getRepo(ws.fullPath)).defaultBranch;
        if (b) {
          forgeDefaultBranch.set(key, b);
          return b;
        }
      } catch {
        // fall back to the current branch
      }
    }
  }
  return currentBranch(ws.path);
}

/** The forge's default branch per repo (`<forge>:<fullPath>`), once looked up; it rarely changes. */
const forgeDefaultBranch = new Map<string, string>();

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
 * `warning`). Undefined when the workspace has no commit yet (a worktree needs one) or git fails (`strict`: throws
 * `WorktreeError(500)` with git's last stderr line instead). Throws
 * `WorktreeError(400)` when `baseBranch` exists neither on origin nor locally.
 */
export async function addTerminalWorktree(
  wsPath: string,
  opts: { id?: string; baseBranch?: string; strict?: boolean } = {},
): Promise<TerminalWorktree | undefined> {
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
        why = `could not fetch origin/${b}: ${gitReason(fetch.stderr) || "not on origin"}; started from local ${b}`;
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
  if (!add.ok) {
    if (opts.strict) throw new WorktreeError(500, lastLine(add.stderr) || "git worktree add failed");
    return undefined;
  }
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
      if (!res.ok) error = gitReason(res.stderr) || "git fetch failed";
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
  const def = await defaultBaseBranch(ctx, ws, { network: fetch });
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

/** One repo of a project terminal: its own worktree (`isolated`), or its checkout when the repo has no commit yet. */
export interface ProjectRepoWorktree {
  name: string;
  workspaceId?: string;
  /** The worktree, or the checkout when not isolated. */
  path: string;
  branch?: string;
  base?: string;
  baseBranch?: string;
  isolated: boolean;
}

export interface ProjectWorktrees {
  /** The project repo's worktree, `<projectDir>/.gm-worktrees/<id>`. */
  path: string;
  branch: string;
  base: string;
  repos: ProjectRepoWorktree[];
  warnings: string[];
}

async function isLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Removes the links in `<dir>/repos/`, one by one and without `recursive`, so nothing walks into a repo. */
async function unlinkRepos(dir: string): Promise<void> {
  const reposDir = path.join(dir, "repos");
  let entries: string[];
  try {
    entries = await readdir(reposDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const link = path.join(reposDir, entry);
    if (await isLink(link)) await rm(link);
  }
}

const hasCommit = async (cwd: string): Promise<boolean> => {
  const head = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return head.ok && head.stdout !== "";
};

/**
 * The worktrees of a project terminal (docs/prd/project-terminal-worktrees.md): one of the project folder's own repo
 * at `<projectDir>/.gm-worktrees/<id>` (cut from its HEAD), and one per repo at `<repo>/.gm-worktrees/<id>` (cut from
 * its base branch), all on `gm-term/<id>`, linked from `<worktree>/repos/<name>`. A repo without a commit is linked to
 * its checkout. Any failure removes everything made and throws a `WorktreeError` naming the repo.
 */
export async function addProjectWorktrees(
  projectDir: string,
  repos: { name: string; workspace: Workspace; baseBranch?: string }[],
  id = newWorktreeId(),
): Promise<ProjectWorktrees> {
  const branch = `${TERMINAL_BRANCH_PREFIX}${id}`;
  const wtPath = path.join(projectDir, WORKTREES_DIR, id);
  const made: ProjectRepoWorktree[] = [];
  const warnings: string[] = [];
  let projectMade = false;
  let current = "project";
  try {
    const own = await addTerminalWorktree(projectDir, { id, strict: true });
    if (!own) throw new WorktreeError(500, "the project folder has no commit");
    projectMade = true;
    const result: ProjectRepoWorktree[] = [];
    for (const repo of repos) {
      current = repo.name;
      const ws = repo.workspace;
      const committed = await hasCommit(ws.path);
      const wt = committed ? await addTerminalWorktree(ws.path, { id, strict: true, ...(repo.baseBranch !== undefined ? { baseBranch: repo.baseBranch } : {}) }) : undefined;
      if (committed && !wt) throw new WorktreeError(500, "git worktree add failed");
      if (!wt) {
        result.push({ name: repo.name, workspaceId: ws.id, path: ws.path, isolated: false });
        continue;
      }
      const entry: ProjectRepoWorktree = {
        name: repo.name,
        workspaceId: ws.id,
        path: wt.path,
        branch: wt.branch,
        base: wt.base,
        ...(wt.baseBranch ? { baseBranch: wt.baseBranch } : {}),
        isolated: true,
      };
      made.push(entry);
      result.push(entry);
      if (wt.warning) warnings.push(`${repo.name}: ${wt.warning}`);
    }
    current = "project";
    // `repos/` is gitignored in the project repo, so the new worktree has no such folder yet.
    await mkdir(path.join(wtPath, "repos"), { recursive: true });
    for (const r of result) {
      current = r.name;
      await symlink(r.path, path.join(wtPath, "repos", r.name), LINK_TYPE);
    }
    return { path: wtPath, branch, base: own.base, repos: result, warnings };
  } catch (err) {
    await unlinkRepos(wtPath).catch(() => undefined);
    const byName = new Map(repos.map((r) => [r.name, r.workspace.path] as const));
    for (const r of made) await removeWorktree(byName.get(r.name)!, r.path, r.branch).catch(() => undefined);
    if (projectMade) await removeWorktree(projectDir, wtPath, branch).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof WorktreeError ? err.status : 500;
    throw new WorktreeError(status, current === "project" && message === "the project folder has no commit" ? message : `${current}: ${message}`);
  }
}

/**
 * Removes a project terminal's worktrees and branches: the `repos/` links first (never following them), then each
 * isolated repo's worktree, then the project repo's. Missing pieces are fine.
 */
export async function removeProjectWorktrees(
  projectDir: string,
  rec: ProjectWorktreeRecord,
  workspacePathOf: (workspaceId: string) => string | undefined,
): Promise<void> {
  await unlinkRepos(rec.path);
  for (const repo of rec.repos) {
    if (!repo.isolated || repo.workspaceId === undefined) continue;
    const wsPath = workspacePathOf(repo.workspaceId);
    if (wsPath) await removeWorktree(wsPath, repo.path, repo.branch);
  }
  await removeWorktree(projectDir, rec.path, rec.branch);
}

export interface ProjectWorktreeState {
  project: WorktreeState;
  repos: { name: string; isolated: boolean; dirty: number; ahead: number }[];
}

/** What a project terminal's worktrees hold; a repo linked to its checkout holds nothing of the terminal's. */
export async function projectWorktreeState(rec: ProjectWorktreeRecord): Promise<ProjectWorktreeState> {
  const project = await worktreeState(rec.path, rec.base);
  const repos = await Promise.all(
    rec.repos.map(async (r) => {
      const s = r.isolated && r.base !== undefined ? await worktreeState(r.path, r.base) : { dirty: 0, ahead: 0 };
      return { name: r.name, isolated: r.isolated, ...s };
    }),
  );
  return { project, repos };
}

export const projectHasWork = (s: ProjectWorktreeState): boolean => hasWork(s.project) || s.repos.some(hasWork);

/**
 * Merge project files (docs/prd/project-terminal-worktrees.md): commits the project worktree's uncommitted changes
 * (`repos/` stays out, it is gitignored), then merges `rec.branch` into the project folder's checked-out branch,
 * fast-forward when possible. A conflict aborts the merge and throws `WorktreeError(409, "merge conflict", { files })`;
 * a dirty project folder throws before anything changes. On success `rec.base` is the worktree's HEAD, so the project
 * repo holds no work any more; the caller saves it.
 */
export async function mergeProjectFiles(projectDir: string, rec: ProjectWorktreeRecord): Promise<{ fastForward: boolean }> {
  const status = await git(projectDir, ["status", "--porcelain"]);
  if (!status.ok) throw new WorktreeError(409, lastLine(status.stderr) || "git status failed in the project folder");
  if (status.stdout !== "") throw new WorktreeError(409, "the project folder has uncommitted changes");
  if (!(await currentBranch(projectDir))) throw new WorktreeError(409, "the project folder is not on a branch (detached HEAD)");
  const wtStatus = await git(rec.path, ["status", "--porcelain"]);
  if (!wtStatus.ok) throw new WorktreeError(409, lastLine(wtStatus.stderr) || "git status failed in the worktree");
  if (wtStatus.stdout !== "") {
    const add = await git(rec.path, ["add", "-A", "--", "."]);
    if (!add.ok) throw new WorktreeError(409, lastLine(add.stderr) || "git add failed");
    const email = await git(rec.path, ["config", "user.email"]);
    const identity = !email.ok || email.stdout === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
    const commit = await git(rec.path, [...identity, "commit", "-q", "--no-verify", "-m", `gm: project files from ${rec.title}`]);
    if (!commit.ok) throw new WorktreeError(409, lastLine(commit.stderr) || lastLine(commit.stdout) || "git commit failed");
  }
  const head = await git(rec.path, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout === "") throw new WorktreeError(409, lastLine(head.stderr) || "the worktree has no commit");
  let fastForward = true;
  const ff = await git(projectDir, ["merge", "-q", "--ff-only", rec.branch]);
  if (!ff.ok) {
    fastForward = false;
    const email = await git(projectDir, ["config", "user.email"]);
    const identity = !email.ok || email.stdout === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
    const merge = await git(projectDir, [...identity, "merge", "-q", "--no-edit", rec.branch]);
    if (!merge.ok) {
      const conflicts = await git(projectDir, ["diff", "--name-only", "--diff-filter=U"]);
      const files = conflicts.ok && conflicts.stdout !== "" ? conflicts.stdout.split("\n").map((f) => f.trim()).filter(Boolean) : [];
      const mergeHead = await git(projectDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
      if (mergeHead.ok && mergeHead.stdout !== "") await git(projectDir, ["merge", "--abort"]);
      if (files.length > 0) throw new WorktreeError(409, "merge conflict", { files });
      throw new WorktreeError(409, lastLine(merge.stderr) || lastLine(merge.stdout) || lastLine(ff.stderr) || "git merge failed");
    }
  }
  rec.base = head.stdout;
  return { fastForward };
}
