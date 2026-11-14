// The WorkspaceHost of a workspace that lives in a container: every operation is a call to its workspace agent
// (agent/server.ts) over HTTP JSON, PTYs over a WebSocket (docs/prd/hosted-sessions.md).
import type { ProjectRepoCommit } from "../hosted-project-pr.js";
import type { RunDetail, RunSummary } from "../runs.js";
import {
  HostError,
  type BranchChoice,
  type EngineStart,
  type FileStat,
  type GitAuth,
  type HostActivity,
  type PrepareTarget,
  type PtyProcess,
  type WorkspaceHost,
} from "./types.js";

const errMessage = (err: unknown): string => {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
};

export class RemoteWorkspaceHost implements WorkspaceHost {
  readonly kind = "remote" as const;
  private readonly base: string;

  constructor(
    readonly url: string,
    private readonly token: string,
  ) {
    this.base = url.replace(/\/+$/, "");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { notFoundUndefined?: boolean } = {}): Promise<T | undefined> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/agent/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new HostError(502, `the workspace agent at ${this.url} did not answer: ${errMessage(err)}`);
    }
    if (res.status === 404 && opts.notFoundUndefined) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new HostError(502, `the workspace agent at ${this.url} did not answer: ${errMessage(err)}`);
    }
    let json: unknown;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const msg = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : res.statusText;
      throw new HostError(res.status, msg);
    }
    return json as T;
  }

  private async must<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return (await this.call<T>(method, path, body)) as T;
  }

  /** For the control plane's run-page proxy (hosted runs): where to send `/runs/<ws>/<runId>/view/*`. */
  viewTarget(workspaceId: string, runId: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.base}/agent/v1/view/${encodeURIComponent(workspaceId)}/${encodeURIComponent(runId)}`,
      headers: { authorization: `Bearer ${this.token}` },
    };
  }

  prepare(p: PrepareTarget & { branch: BranchChoice; cloneUrl?: string; auth?: GitAuth }): Promise<{ workspaceId: string; branch: string }> {
    return this.must("POST", "/prepare", p);
  }

  async spawnPty(p: { workspaceId: string; argv: string[]; env: Record<string, string>; cols: number; rows: number }): Promise<PtyProcess> {
    const { id, pid } = await this.must<{ id: string; pid: number }>("POST", "/pty", p);
    const wsUrl = this.base.replace(/^http/, "ws");
    const fail = (why: string) => new HostError(502, `the workspace agent at ${this.url} did not open the terminal: ${why}`);
    let socket: WebSocket;
    try {
      // undici's WebSocket takes `{ headers }`; the DOM typings know only protocols.
      socket = new WebSocket(`${wsUrl}/agent/v1/pty/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${this.token}` } } as unknown as string[]);
    } catch (err) {
      throw fail(errMessage(err));
    }
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(e: { exitCode: number }) => void>();
    let exited: number | undefined;
    const exit = (code: number): void => {
      if (exited !== undefined) return;
      exited = code;
      for (const cb of exitListeners) cb({ exitCode: code });
    };
    // Registered before `open`: the agent flushes the buffered output right after the upgrade.
    socket.addEventListener("message", (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      const m = msg as { type?: string; data?: unknown; code?: unknown };
      if (m.type === "data" && typeof m.data === "string") for (const cb of dataListeners) cb(m.data);
      else if (m.type === "exit") exit(typeof m.code === "number" ? m.code : -1);
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(fail("the connection failed"));
      };
      const onClose = (ev: CloseEvent): void => {
        cleanup();
        reject(fail(`closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`));
      };
      const cleanup = (): void => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
    socket.addEventListener("close", () => exit(-1));
    const send = (msg: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };
    return {
      pid,
      process: undefined,
      onData: (cb) => {
        dataListeners.add(cb);
        return { dispose: () => dataListeners.delete(cb) };
      },
      onExit: (cb) => {
        exitListeners.add(cb);
        if (exited !== undefined) cb({ exitCode: exited });
        return { dispose: () => exitListeners.delete(cb) };
      },
      write: (data) => send({ type: "input", data }),
      resize: (cols, rows) => send({ type: "resize", cols, rows }),
      kill: (signal) => send(signal !== undefined ? { type: "kill", signal } : { type: "kill" }),
    };
  }

  startEngine(p: { workspaceId: string; args: string[]; env: Record<string, string>; timeoutMs: number; resumeRunId?: string }): Promise<EngineStart> {
    return this.must("POST", "/engine/start", p);
  }

  async readFile(workspaceId: string, rel: string): Promise<string | undefined> {
    return (await this.call<{ text: string }>("POST", "/file", { workspaceId, path: rel }, { notFoundUndefined: true }))?.text;
  }

  stat(workspaceId: string, rel: string): Promise<FileStat | undefined> {
    return this.call<FileStat>("POST", "/stat", { workspaceId, path: rel }, { notFoundUndefined: true });
  }

  async listFiles(workspaceId: string, rel: string, opts: { glob?: string } = {}): Promise<string[]> {
    const body = opts.glob !== undefined ? { workspaceId, path: rel, glob: opts.glob } : { workspaceId, path: rel };
    return (await this.must<{ files: string[] }>("POST", "/files", body)).files;
  }

  async listRuns(workspaceId: string): Promise<RunSummary[]> {
    return (await this.must<{ runs: RunSummary[] }>("POST", "/runs", { workspaceId })).runs;
  }

  runDetail(workspaceId: string, runId: string): Promise<RunDetail | undefined> {
    return this.call<RunDetail>("POST", "/run", { workspaceId, runId }, { notFoundUndefined: true });
  }

  async git(
    workspaceId: string,
    args: string[],
    opts: { onStderr?: (chunk: string) => void; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const body = opts.timeoutMs !== undefined ? { workspaceId, args, timeoutMs: opts.timeoutMs } : { workspaceId, args };
    const res = await this.must<{ exitCode: number; stdout: string; stderr: string }>("POST", "/git", body);
    if (opts.onStderr && res.stderr !== "") opts.onStderr(res.stderr);
    return res;
  }

  activity(): Promise<HostActivity> {
    return this.must("GET", "/activity");
  }

  async changes(workspaceId: string): Promise<string[]> {
    return (await this.must<{ changes: string[] }>("POST", "/changes", { workspaceId })).changes;
  }

  /** `filter` stays here: the agent always skips secrets (isSecretPath) and nothing else. */
  save(p: { workspaceId: string; branch: string; message: string; auth?: GitAuth; filter?: (path: string) => boolean }): Promise<{ pushed: boolean; skipped: string[]; error?: string }> {
    const { workspaceId, branch, message, auth } = p;
    return this.must("POST", "/save", auth ? { workspaceId, branch, message, auth } : { workspaceId, branch, message });
  }

  async discard(workspaceId: string): Promise<void> {
    await this.call("POST", "/discard", { workspaceId });
  }

  async loginFiles(op: "get" | "put", providers: string[], files?: Record<string, string>): Promise<Record<string, string>> {
    const body = files !== undefined ? { op, providers, files } : { op, providers };
    return (await this.must<{ files: Record<string, string> }>("POST", "/login-files", body)).files;
  }

  /** Hosted runs only: writes files into the workspace (paths relative to it); answers each file's absolute path. */
  async writeFiles(workspaceId: string, files: Record<string, string>): Promise<Record<string, string>> {
    return (await this.must<{ paths: Record<string, string> }>("POST", "/write-files", { workspaceId, files })).paths;
  }

  /** Hosted runs: the files of a run folder (without `worktrees/`), for the run archive; undefined when it is missing. */
  async runFolder(workspaceId: string, runId: string): Promise<{ files: { path: string; content: Buffer }[]; skipped: string[] } | undefined> {
    const res = await this.call<{ files: { path: string; content: string }[]; skipped: string[] }>("POST", "/run-folder", { workspaceId, runId }, { notFoundUndefined: true });
    return res && { files: res.files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "base64") })), skipped: res.skipped };
  }

  /** Hosted project runs: commits and pushes `gm/<runId>` in every changed repository of the project folder. */
  async commitProjectRun(projectId: string, runId: string, auth?: GitAuth): Promise<ProjectRepoCommit[]> {
    return (await this.must<{ repos: ProjectRepoCommit[] }>("POST", "/project-pr", auth ? { projectId, runId, auth } : { projectId, runId })).repos;
  }

  pushBranch(workspaceId: string, opts: { auth?: GitAuth } = {}): Promise<{ ok: boolean; error?: string }> {
    return this.must("POST", "/push-branch", opts.auth ? { workspaceId, auth: opts.auth } : { workspaceId });
  }
}
