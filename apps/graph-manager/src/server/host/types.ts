// The seam between graph-manager and the machine a workspace lives on (docs/prd/hosted-sessions.md): the local
// host (host/local.ts) runs everything on this server; a remote host forwards the same operations to an agent.
import type { RunDetail, RunSummary } from "../runs.js";

export type ForgeKind = "github" | "gitlab";
export interface RepoRef {
  forge: ForgeKind;
  owner: string;
  name: string;
  baseUrl?: string;
}
/** Per-command forge auth: applied as `git -c http.extraHeader=…` (forges.ts gitAuthArgs), never written to .git/config. */
export interface GitAuth {
  forge: ForgeKind;
  token: string;
}
export type BranchChoice = { new: string } | { existing: string };
/**
 * What `prepare` opens: one repository, or a project (every repository on the same branch, plus the project folder
 * `<workspacesDir>/.projects/<id>`). `cloneUrls` of a project: one per repository, in `repos` order.
 */
export type PrepareTarget = { repo: RepoRef } | { project: { id: string; name?: string; repos: RepoRef[]; cloneUrls?: string[] } };

/** The workspace id of a repository's clone: `<forge>~<owner…>~<name>` (a GitLab subgroup owner adds parts). */
export function workspaceIdOf(repo: RepoRef): string {
  return [repo.forge, ...repo.owner.split("/"), repo.name].join("~");
}

/** The repository of a workspace id (the inverse of `workspaceIdOf`); undefined when it is not one. */
export function repoRefOf(workspaceId: string): RepoRef | undefined {
  const parts = workspaceId.split("~");
  const forge = parts[0];
  if ((forge !== "github" && forge !== "gitlab") || parts.length < 3 || parts.some((p) => p === "")) return undefined;
  return { forge, owner: parts.slice(1, -1).join("/"), name: parts[parts.length - 1]! };
}

/** The subset of node-pty's IPty graph-manager uses; IPty is assignable to it. */
export interface PtyProcess {
  readonly pid: number;
  /** Foreground process name when known (node-pty `process`); remote PTYs may leave it undefined. */
  readonly process?: string;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** The result of starting the engine until it hands the run off to the background. */
export type EngineStart = { ok: true; stdout: string } | { ok: false; error: string; exitCode?: number; output: string };

export interface FileStat {
  kind: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
  symlink: boolean;
}

export interface HostActivity {
  terminals: number;
  liveRuns: number;
  lastInputAt: string | null;
  lastOutputAt: string | null;
}

export interface WorkspaceHost {
  readonly kind: "local" | "remote";
  prepare(p: PrepareTarget & { branch: BranchChoice; cloneUrl?: string; auth?: GitAuth }): Promise<{ workspaceId: string; branch: string }>;
  /** argv [] = the host's default shell. env is ADDED to the host's own terminal base env. cwd = the workspace. */
  spawnPty(p: { workspaceId: string; argv: string[]; env: Record<string, string>; cols: number; rows: number }): Promise<PtyProcess>;
  /** env is ADDED to the host's engine base env. resumeRunId: take over a foreign lock of that run, as resume does. */
  startEngine(p: { workspaceId: string; args: string[]; env: Record<string, string>; timeoutMs: number; resumeRunId?: string }): Promise<EngineStart>;
  readFile(workspaceId: string, rel: string): Promise<string | undefined>;
  /** lstat-style info of a path inside the workspace; undefined when missing, absolute, or resolving outside it. */
  stat(workspaceId: string, rel: string): Promise<FileStat | undefined>;
  /** Files (not dirs, not symlinks) directly in `rel` matching `glob` (only `*` wildcards; default `*`), names sorted. */
  listFiles(workspaceId: string, rel: string, opts?: { glob?: string }): Promise<string[]>;
  listRuns(workspaceId: string): Promise<RunSummary[]>;
  runDetail(workspaceId: string, runId: string): Promise<RunDetail | undefined>;
  git(
    workspaceId: string,
    args: string[],
    opts?: { onStderr?: (chunk: string) => void; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  activity(): Promise<HostActivity>;
  changes(workspaceId: string): Promise<string[]>;
  save(p: {
    workspaceId: string;
    branch: string;
    message: string;
    auth?: GitAuth;
    filter?: (path: string) => boolean;
  }): Promise<{ pushed: boolean; skipped: string[]; error?: string }>;
  discard(workspaceId: string): Promise<void>;
  loginFiles(op: "get" | "put", providers: string[], files?: Record<string, string>): Promise<Record<string, string>>;
  pushBranch(workspaceId: string, opts?: { auth?: GitAuth }): Promise<{ ok: boolean; error?: string }>;
}

/** A refused host operation; `status` is the HTTP status the route answers with `{ error: message }`. */
export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}
