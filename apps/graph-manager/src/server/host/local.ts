// The open-source WorkspaceHost: everything runs on this server, in the workspaces folder (docs/prd/hosted-sessions.md).
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import pty from "node-pty";
import { lockHost, readLock, RUNS_DIR } from "graph-execution/api";
import { engineCommand, INTERNAL_ENV, lastLines } from "../engine.js";
import { gitAuthArgs } from "../forges.js";
import { lastLine, scrub } from "../pr.js";
import {
  PROJECTS_DIR,
  ProjectFolderError,
  createProjectFolder,
  projectDirOf,
  readProjectFile,
  syncProjectFolder,
  type Project,
} from "../projects.js";
import { PROJECT_PREFIX, workspaceHome, type RunHome } from "../runhome.js";
import { listHomeRuns, runDetail, type RunDetail, type RunSummary } from "../runs.js";
import { LOGIN_FILES } from "../sandbox-run.js";
import { defaultShell, terminalEnv } from "../terminals.js";
import { insideWorkspaces, listWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";
import {
  HostError,
  type BranchChoice,
  type EngineStart,
  type FileStat,
  type ForgeKind,
  type GitAuth,
  type HostActivity,
  type PrepareTarget,
  type PtyProcess,
  type RepoRef,
  type WorkspaceHost,
  workspaceIdOf,
} from "./types.js";

export interface LocalWorkspaceHostOptions {
  workspacesDir: string;
  graphExecutionBin: string;
  /** View cache (failure reasons of runs) + reviewers. */
  dataDir?: string;
  /** Prepended to PATH of terminals; holds the `graph-execution` shim. */
  binDir?: string;
  /** Set as GRAPH_EXECUTION_REVIEWERS in every terminal. */
  reviewersFile?: string;
  /** The base env of terminals; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  shell?: string;
  platform?: NodeJS.Platform;
  /** Home folder whose agent login files loginFiles reads/writes; unset = no-op (local mode: the user's own home is used). */
  loginHome?: string;
  forgeAuth?: (forge: ForgeKind) => Promise<GitAuth | undefined>;
}

const PROJECT_ID = /^[a-z0-9-]+$/;

/** The folder of a workspace id or `project~<id>` in `workspacesDir`; undefined when unknown. */
export function localWorkspacePath(workspacesDir: string, id: string): string | undefined {
  if (id.startsWith(PROJECT_PREFIX)) {
    const pid = id.slice(PROJECT_PREFIX.length);
    if (!PROJECT_ID.test(pid)) return undefined;
    const dir = projectDirOf(workspacesDir, pid);
    return existsSync(path.join(dir, ".git")) ? dir : undefined;
  }
  return resolveWorkspace(workspacesDir, id)?.path;
}

type GitResult = { exitCode: number; stdout: string; stderr: string };

async function runGit(cwd: string, args: string[], opts: { onStderr?: (chunk: string) => void; timeoutMs?: number } = {}): Promise<GitResult> {
  const sub = execa("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    reject: false,
    stdin: "ignore",
    all: false,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  if (opts.onStderr) {
    const cb = opts.onStderr;
    sub.stderr?.on("data", (c: Buffer | string) => cb(String(c)));
  }
  const res = await sub;
  return {
    exitCode: typeof res.exitCode === "number" ? res.exitCode : -1,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? "") || (res.exitCode === 0 ? "" : (res.message ?? "")),
  };
}

const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/** The path part of a porcelain status line (`XY path`, `XY a -> b` → b), unquoted. */
function statusPath(line: string): string {
  let p = line.slice(3);
  const arrow = p.indexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p) as string;
    } catch {
      // keep it as it is
    }
  }
  return p;
}

/** A porcelain status line with its path(s) under `<repo>/`: `?? a.txt` → `?? api/a.txt`, `R  a -> b` → `R  api/a -> api/b`. */
function prefixStatusLine(line: string, repo: string): string {
  const head = line.slice(0, 3);
  const rest = line.slice(3);
  const one = (p: string): string => (p.startsWith('"') ? `"${repo}/${p.slice(1)}` : `${repo}/${p}`);
  const arrow = rest.indexOf(" -> ");
  return arrow === -1 ? head + one(rest) : `${head}${one(rest.slice(0, arrow))} -> ${one(rest.slice(arrow + 4))}`;
}

function globRegex(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${body}$`);
}

export class LocalWorkspaceHost implements WorkspaceHost {
  readonly kind = "local" as const;
  private readonly termEnv: Record<string, string>;
  private ptys = 0;
  private lastInputAt: Date | undefined;
  private lastOutputAt: Date | undefined;

  constructor(private readonly opts: LocalWorkspaceHostOptions) {
    this.termEnv = terminalEnv(opts.env ?? process.env, opts.binDir, opts.reviewersFile, opts.platform);
  }

  // ---- workspaces ----

  /** The folder of a workspace id or `project~<id>`; undefined when unknown. */
  private pathOf(id: string): string | undefined {
    return localWorkspacePath(this.opts.workspacesDir, id);
  }

  private mustPath(id: string): string {
    const p = this.pathOf(id);
    if (p === undefined) throw new HostError(404, "unknown workspace");
    return p;
  }

  private async homeOf(id: string): Promise<RunHome | undefined> {
    if (id.startsWith(PROJECT_PREFIX)) {
      const dir = this.pathOf(id);
      if (dir === undefined) return undefined;
      const pid = id.slice(PROJECT_PREFIX.length);
      const name = (await readProjectFile(dir).catch(() => undefined))?.name ?? pid;
      return { kind: "project", id, path: dir, project: { id: pid, name, repos: [], workspaces: [], createdAt: "" } };
    }
    const ws = resolveWorkspace(this.opts.workspacesDir, id);
    return ws && workspaceHome(ws);
  }

  /** `rel` resolved inside the workspace (symlinks followed), or undefined when it escapes it or does not exist. */
  private async inside(root: string, rel: string): Promise<string | undefined> {
    if (path.isAbsolute(rel) || rel.includes("\0")) return undefined;
    const full = path.resolve(root, rel);
    try {
      const [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
      return isInside(realRoot, real) ? full : undefined;
    } catch {
      return undefined;
    }
  }

  private async authFor(forge: string | undefined, explicit: GitAuth | undefined): Promise<GitAuth | undefined> {
    if (explicit) return explicit;
    if (forge !== "github" && forge !== "gitlab") return undefined;
    return this.opts.forgeAuth?.(forge);
  }

  private static authArgs(auth: GitAuth | undefined): string[] {
    return auth ? gitAuthArgs(auth.forge, auth.token) : [];
  }

  private forgeOf(id: string): string | undefined {
    return id.startsWith(PROJECT_PREFIX) ? undefined : id.split("~")[0];
  }

  // ---- prepare ----

  async prepare(p: PrepareTarget & { branch: BranchChoice; cloneUrl?: string; auth?: GitAuth }): Promise<{ workspaceId: string; branch: string }> {
    if ("project" in p) return this.prepareProject(p.project, p.branch, p.auth);
    return this.prepareRepo(p.repo, p.branch, p.cloneUrl, p.auth);
  }

  /**
   * Every repository of the project on the same branch (as one repository's prepare each; the first failure is thrown,
   * the clones done before it stay), then the project folder: created when missing, else synced to the repositories.
   */
  private async prepareProject(
    project: { id: string; name?: string; repos: RepoRef[]; cloneUrls?: string[] },
    branch: BranchChoice,
    auth: GitAuth | undefined,
  ): Promise<{ workspaceId: string; branch: string }> {
    if (!PROJECT_ID.test(project.id)) throw new HostError(400, "invalid project id");
    if (project.repos.length === 0) throw new HostError(400, "a project needs repositories");
    const target = "new" in branch ? branch.new : branch.existing;
    const workspaces: Workspace[] = [];
    for (const [i, repo] of project.repos.entries()) {
      const label = `${repo.owner}/${repo.name}`;
      // Each error names its repository (the dirty-clone 409 does already).
      const { workspaceId } = await this.prepareRepo(repo, branch, project.cloneUrls?.[i], auth).catch((err: unknown) => {
        if (err instanceof HostError && !err.message.startsWith(label)) throw new HostError(err.status, `${label}: ${err.message}`);
        throw err;
      });
      const ws = resolveWorkspace(this.opts.workspacesDir, workspaceId);
      if (!ws) throw new HostError(500, `${repo.owner}/${repo.name}: the clone is missing`);
      workspaces.push(ws);
    }
    const full: Project = {
      id: project.id,
      name: project.name ?? project.id,
      repos: project.repos,
      workspaces: workspaces.map((w) => w.id),
      createdAt: "",
    };
    try {
      if (existsSync(projectDirOf(this.opts.workspacesDir, project.id))) await syncProjectFolder(this.opts.workspacesDir, full, workspaces);
      else await createProjectFolder(this.opts.workspacesDir, full, workspaces);
    } catch (err) {
      if (err instanceof ProjectFolderError) throw new HostError(err.status, err.message);
      throw err;
    }
    return { workspaceId: `${PROJECT_PREFIX}${project.id}`, branch: target };
  }

  /**
   * The clones of a project folder, in `project.json` order: each repo's name and the workspace its link points to
   * (matched by real path, so git runs in the clone itself, never through the link). Undefined when it is no project.
   */
  private async projectClones(id: string): Promise<{ name: string; workspaceId: string }[] | undefined> {
    if (!id.startsWith(PROJECT_PREFIX)) return undefined;
    const dir = this.mustPath(id);
    const file = await readProjectFile(dir);
    if (!file) throw new HostError(500, "the project folder has no project.json");
    const all = await listWorkspaces(this.opts.workspacesDir);
    const realOf = async (p: string): Promise<string | undefined> => realpath(p).catch(() => undefined);
    const reals = await Promise.all(all.map((w) => realOf(w.path)));
    const out: { name: string; workspaceId: string }[] = [];
    for (const repo of file.repos) {
      const real = await realOf(path.resolve(dir, repo.path));
      const i = real === undefined ? -1 : reals.indexOf(real);
      if (i === -1) throw new HostError(409, `${repo.name}: the clone of this repository is missing`);
      out.push({ name: repo.name, workspaceId: all[i]!.id });
    }
    return out;
  }

  private async prepareRepo(repo: RepoRef, branch: BranchChoice, cloneUrl: string | undefined, explicitAuth: GitAuth | undefined): Promise<{ workspaceId: string; branch: string }> {
    const owner = repo.owner.split("/");
    const parts = [repo.forge, ...owner, repo.name];
    if (parts.some((s) => s === "" || s === "." || s === ".." || s.startsWith(".") || s.includes("\\") || s.includes("\0") || s.includes("~"))) {
      throw new HostError(400, "invalid repository");
    }
    const root = this.opts.workspacesDir;
    const workspaceId = workspaceIdOf(repo);
    const dest = path.join(root, ...parts);
    if (!insideWorkspaces(root, dest)) throw new HostError(400, "invalid repository");
    const target = "new" in branch ? branch.new : branch.existing;
    await mkdir(root, { recursive: true });
    const valid = target === "" || target.startsWith("-") ? undefined : await runGit(root, ["check-ref-format", "--branch", target]);
    if (!valid || valid.exitCode !== 0 || valid.stdout.trim() !== target) throw new HostError(400, `invalid branch name: ${target}`);

    const auth = await this.authFor(repo.forge, explicitAuth);
    const token = auth?.token ?? "";
    const authArgs = LocalWorkspaceHost.authArgs(auth);
    if (!existsSync(path.join(dest, ".git"))) {
      if (existsSync(dest)) throw new HostError(409, `${repo.owner}/${repo.name}: the destination exists and is not a git checkout`);
      const url =
        cloneUrl ??
        (repo.forge === "github"
          ? `https://github.com/${repo.owner}/${repo.name}.git`
          : `${(repo.baseUrl ?? "https://gitlab.com").replace(/\/+$/, "")}/${repo.owner}/${repo.name}.git`);
      await mkdir(path.dirname(dest), { recursive: true });
      const res = await runGit(root, [...authArgs, "clone", "--", url, dest]);
      if (res.exitCode !== 0) {
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        throw new HostError(502, scrub(`clone failed: ${lastLine(res.stderr || res.stdout)}`, token));
      }
      await mkdir(path.join(dest, ".git", "info"), { recursive: true });
      await appendFile(path.join(dest, ".git", "info", "exclude"), ".graph-execution/\n");
    } else {
      const res = await runGit(dest, [...authArgs, "fetch", "--prune", "origin"]);
      if (res.exitCode !== 0) throw new HostError(502, scrub(`fetch failed: ${lastLine(res.stderr || res.stdout)}`, token));
    }

    const current = (await runGit(dest, ["branch", "--show-current"])).stdout.trim();
    // Git-ignored files never show here (git status leaves them out), so only real changes block a branch switch.
    const blocking = await this.changesAt(dest);
    if (current !== target && blocking.length > 0) {
      throw new HostError(409, `${repo.owner}/${repo.name} has uncommitted changes. Close its session with Push or Discard first.`);
    }
    const hasRef = async (ref: string): Promise<boolean> => (await runGit(dest, ["rev-parse", "--verify", "--quiet", ref])).exitCode === 0;
    const must = async (args: string[]): Promise<void> => {
      const res = await runGit(dest, args);
      if (res.exitCode !== 0) throw new HostError(409, `git ${args[0]} failed: ${lastLine(res.stderr || res.stdout)}`);
    };
    if ("new" in branch) {
      if (await hasRef(`refs/heads/${target}`)) throw new HostError(409, `branch ${target} already exists`);
      const head = await runGit(dest, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      const base = head.exitCode === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : "origin/main";
      await must(["checkout", "-q", "-b", target, base]);
    } else if (await hasRef(`refs/heads/${target}`)) {
      await must(["checkout", "-q", target]);
      await runGit(dest, ["merge", "-q", "--ff-only", `origin/${target}`]);
    } else if (await hasRef(`refs/remotes/origin/${target}`)) {
      await must(["checkout", "-q", "-b", target, "--track", `origin/${target}`]);
    } else {
      throw new HostError(404, `branch ${target} not found`);
    }
    return { workspaceId, branch: target };
  }

  // ---- processes ----

  async spawnPty(p: { workspaceId: string; argv: string[]; env: Record<string, string>; cols: number; rows: number }): Promise<PtyProcess> {
    const cwd = this.mustPath(p.workspaceId);
    const [file, ...args] = p.argv.length > 0 ? p.argv : [this.opts.shell ?? defaultShell(this.opts.env ?? process.env)];
    const proc = pty.spawn(file!, args, { name: "xterm-256color", cols: p.cols, rows: p.rows, cwd, env: { ...this.termEnv, ...p.env } });
    this.ptys++;
    let alive = true;
    proc.onData(() => {
      this.lastOutputAt = new Date();
    });
    proc.onExit(() => {
      if (!alive) return;
      alive = false;
      this.ptys--;
    });
    return {
      get pid() {
        return proc.pid;
      },
      get process() {
        return proc.process;
      },
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit(cb),
      write: (data) => {
        this.lastInputAt = new Date();
        proc.write(data);
      },
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => proc.kill(signal),
    };
  }

  async startEngine(p: { workspaceId: string; args: string[]; env: Record<string, string>; timeoutMs: number; resumeRunId?: string }): Promise<EngineStart> {
    const cwd = this.mustPath(p.workspaceId);
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1" };
    delete env.GM_PASSWORD;
    delete env.GM_AGENT_TOKEN;
    delete env.GM_GATEWAY_SECRET;
    for (const name of INTERNAL_ENV) delete env[name];
    if (p.resumeRunId !== undefined) {
      // A lock of another host on a run that is not sandboxed was left by graph-manager's previous container (its
      // hostname changes when it is recreated); that process is gone, so the lock may be taken over.
      const lock = await readLock(path.join(cwd, RUNS_DIR, p.resumeRunId)).catch(() => undefined);
      if (lock && lock.host !== lockHost()) env.GRAPH_EXECUTION_TAKE_LOCK_FROM = lock.host;
    }
    Object.assign(env, p.env);
    const cmd = engineCommand(this.opts.graphExecutionBin, p.args);
    const res = await execa(cmd.file, cmd.args, { cwd, env, extendEnv: false, reject: false, all: true, stdin: "ignore", timeout: p.timeoutMs });
    if (res.exitCode !== 0) {
      const output = typeof res.all === "string" && res.all.trim() !== "" ? res.all : (res.message ?? "");
      const tail = lastLines(output, 20);
      const exitCode = typeof res.exitCode === "number" ? res.exitCode : undefined;
      return { ok: false, error: tail || `graph-execution exited ${String(res.exitCode)}`, exitCode, output: tail };
    }
    return { ok: true, stdout: String(res.stdout ?? "") };
  }

  // ---- files ----

  async readFile(workspaceId: string, rel: string): Promise<string | undefined> {
    const root = this.pathOf(workspaceId);
    if (root === undefined) return undefined;
    const full = await this.inside(root, rel);
    if (full === undefined) return undefined;
    return readFile(full, "utf8").catch(() => undefined);
  }

  /**
   * A symlink is reported (`symlink: true`) wherever it points; kind, size and mtime are its target's only when that
   * resolves inside the workspace (else `other`, 0, 0), so the answer never tells whether a path outside exists.
   */
  async stat(workspaceId: string, rel: string): Promise<FileStat | undefined> {
    const root = this.pathOf(workspaceId);
    if (root === undefined || path.isAbsolute(rel) || rel.includes("\0")) return undefined;
    const full = path.resolve(root, rel);
    if (!isInside(path.resolve(root), full)) return undefined;
    let link;
    try {
      link = await lstat(full);
    } catch {
      return undefined;
    }
    const target = await this.inside(root, rel);
    if (target === undefined) {
      return link.isSymbolicLink() ? { kind: "other", size: 0, mtimeMs: 0, symlink: true } : undefined;
    }
    try {
      const st = await stat(full);
      return { kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other", size: st.size, mtimeMs: st.mtimeMs, symlink: link.isSymbolicLink() };
    } catch {
      return undefined;
    }
  }

  async listFiles(workspaceId: string, rel: string, opts: { glob?: string } = {}): Promise<string[]> {
    const root = this.pathOf(workspaceId);
    if (root === undefined) return [];
    const dir = await this.inside(root, rel);
    if (dir === undefined) return [];
    const re = globRegex(opts.glob ?? "*");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && !e.isSymbolicLink() && re.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  // ---- runs ----

  async listRuns(workspaceId: string): Promise<RunSummary[]> {
    const home = await this.homeOf(workspaceId);
    return home ? listHomeRuns(home, undefined, this.opts.dataDir) : [];
  }

  async runDetail(workspaceId: string, runId: string): Promise<RunDetail | undefined> {
    const home = await this.homeOf(workspaceId);
    return home ? runDetail(home, runId, this.opts.dataDir) : undefined;
  }

  async activity(): Promise<HostActivity> {
    const root = this.opts.workspacesDir;
    const homes: RunHome[] = (await listWorkspaces(root)).map(workspaceHome);
    try {
      for (const e of await readdir(path.join(root, PROJECTS_DIR), { withFileTypes: true })) {
        if (!e.isDirectory() || !PROJECT_ID.test(e.name)) continue;
        const home = await this.homeOf(`${PROJECT_PREFIX}${e.name}`);
        if (home) homes.push(home);
      }
    } catch {
      // no projects
    }
    const runs = await Promise.all(homes.map((h) => listHomeRuns(h, undefined, this.opts.dataDir)));
    return {
      terminals: this.ptys,
      liveRuns: runs.flat().filter((r) => r.kind === "live").length,
      lastInputAt: this.lastInputAt?.toISOString() ?? null,
      lastOutputAt: this.lastOutputAt?.toISOString() ?? null,
    };
  }

  // ---- git ----

  async git(workspaceId: string, args: string[], opts?: { onStderr?: (chunk: string) => void; timeoutMs?: number }): Promise<GitResult> {
    return runGit(this.mustPath(workspaceId), args, opts);
  }

  private async changesAt(cwd: string): Promise<string[]> {
    const res = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).graph-execution"]);
    if (res.exitCode !== 0) throw new HostError(500, `git status failed: ${lastLine(res.stderr)}`);
    return res.stdout.split("\n").filter((l) => l.trim() !== "");
  }

  async changes(workspaceId: string): Promise<string[]> {
    const clones = await this.projectClones(workspaceId);
    if (!clones) return this.changesAt(this.mustPath(workspaceId));
    const out: string[] = [];
    // `XY path` → `XY <repo>/path` (a rename's both paths), so the lines keep git's porcelain shape.
    for (const c of clones) {
      for (const line of await this.changesAt(this.mustPath(c.workspaceId))) out.push(prefixStatusLine(line, c.name));
    }
    return out;
  }

  async save(p: {
    workspaceId: string;
    branch: string;
    message: string;
    auth?: GitAuth;
    filter?: (path: string) => boolean;
  }): Promise<{ pushed: boolean; skipped: string[]; error?: string }> {
    const clones = await this.projectClones(p.workspaceId);
    if (clones) {
      // Every repository to the same branch; the project folder itself has no remote and is never pushed.
      let pushed = true;
      const skipped: string[] = [];
      const errors: string[] = [];
      for (const c of clones) {
        const filter = p.filter;
        const res = await this.save({
          workspaceId: c.workspaceId,
          branch: p.branch,
          message: p.message,
          ...(p.auth ? { auth: p.auth } : {}),
          ...(filter ? { filter: (f: string) => filter(`${c.name}/${f}`) } : {}),
        }).catch((err: unknown) => ({ pushed: false, skipped: [] as string[], error: err instanceof Error ? err.message : String(err) }));
        skipped.push(...res.skipped.map((f) => `${c.name}/${f}`));
        if (!res.pushed) {
          pushed = false;
          errors.push(`${c.name}: ${res.error ?? "push failed"}`);
        }
      }
      return pushed ? { pushed, skipped } : { pushed, skipped, error: errors.join("; ") };
    }
    const cwd = this.mustPath(p.workspaceId);
    const auth = await this.authFor(this.forgeOf(p.workspaceId), p.auth);
    const token = auth?.token ?? "";
    const paths = (await this.changesAt(cwd)).map(statusPath);
    // Git-ignored files are never listed by git status, so they are never staged; `filter` can leave out more.
    const skipped = p.filter === undefined ? [] : paths.filter((f) => !p.filter!(f));
    const stage = paths.filter((f) => !skipped.includes(f));
    const fail = (res: GitResult) => ({ pushed: false, skipped, error: scrub(lastLine(res.stderr || res.stdout), token) });
    if (stage.length > 0) {
      const add = await runGit(cwd, ["add", "-A", "--", ...stage]);
      if (add.exitCode !== 0) return fail(add);
    }
    const staged = await runGit(cwd, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 1) {
      const email = await runGit(cwd, ["config", "user.email"]);
      const identity = email.stdout.trim() === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
      const commit = await runGit(cwd, [...identity, "commit", "-q", "-m", p.message]);
      if (commit.exitCode !== 0) return fail(commit);
    }
    const push = await runGit(cwd, [...LocalWorkspaceHost.authArgs(auth), "push", "origin", `HEAD:refs/heads/${p.branch}`]);
    if (push.exitCode !== 0) return fail(push);
    return { pushed: true, skipped };
  }

  async discard(workspaceId: string): Promise<void> {
    const clones = await this.projectClones(workspaceId);
    if (clones) {
      for (const c of clones) await this.discard(c.workspaceId);
      return;
    }
    const cwd = this.mustPath(workspaceId);
    const reset = await runGit(cwd, ["reset", "-q", "--hard"]);
    if (reset.exitCode !== 0) throw new HostError(500, `git reset failed: ${lastLine(reset.stderr)}`);
    // Ignored files stay (the clean has no -x); graph-execution's own folder stays even where it is not ignored.
    const clean = await runGit(cwd, ["clean", "-fdq", "-e", ".graph-execution"]);
    if (clean.exitCode !== 0) throw new HostError(500, `git clean failed: ${lastLine(clean.stderr)}`);
  }

  async pushBranch(workspaceId: string, opts: { auth?: GitAuth } = {}): Promise<{ ok: boolean; error?: string }> {
    const clones = await this.projectClones(workspaceId);
    if (clones) {
      const errors: string[] = [];
      for (const c of clones) {
        const res = await this.pushBranch(c.workspaceId, opts);
        if (!res.ok) errors.push(`${c.name}: ${res.error ?? "push failed"}`);
      }
      return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join("; ") };
    }
    const cwd = this.mustPath(workspaceId);
    const branch = (await runGit(cwd, ["branch", "--show-current"])).stdout.trim();
    if (branch === "") return { ok: false, error: "no branch checked out" };
    const auth = await this.authFor(this.forgeOf(workspaceId), opts.auth);
    const res = await runGit(cwd, [...LocalWorkspaceHost.authArgs(auth), "push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
    return res.exitCode === 0 ? { ok: true } : { ok: false, error: scrub(lastLine(res.stderr || res.stdout), auth?.token ?? "") };
  }

  // ---- agent logins ----

  async loginFiles(op: "get" | "put", providers: string[], files: Record<string, string> = {}): Promise<Record<string, string>> {
    const home = this.opts.loginHome;
    if (home === undefined) return {};
    const entries = providers.flatMap((p) => LOGIN_FILES[p] ?? []);
    if (op === "get") {
      const out: Record<string, string> = {};
      const walk = async (rel: string): Promise<void> => {
        let items;
        try {
          items = await readdir(path.join(home, rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of items) {
          const child = `${rel}/${e.name}`;
          if (e.isDirectory()) await walk(child);
          else if (e.isFile()) await read(child);
        }
      };
      const read = async (rel: string): Promise<void> => {
        try {
          out[rel] = (await readFile(path.join(home, rel))).toString("base64");
        } catch {
          // not logged in with this file
        }
      };
      for (const entry of entries) {
        if (entry.endsWith("/")) await walk(entry.slice(0, -1));
        else await read(entry);
      }
      return out;
    }
    const allowed = (rel: string): boolean => {
      if (rel === "" || rel.includes("\0") || rel.includes("\\") || path.posix.isAbsolute(rel)) return false;
      if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) return false;
      return entries.some((e) => (e.endsWith("/") ? rel.startsWith(e) : rel === e));
    };
    for (const rel of Object.keys(files)) if (!allowed(rel)) throw new HostError(400, `not a login file: ${rel}`);
    for (const [rel, b64] of Object.entries(files)) {
      const full = path.join(home, ...rel.split("/"));
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await writeFile(full, Buffer.from(b64, "base64"), { mode: 0o600 });
    }
    return {};
  }
}
