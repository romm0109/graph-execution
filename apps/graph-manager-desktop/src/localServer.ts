import { execFile, fork as nodeFork, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface LocalServerOptions {
  serverEntry: string;
  graphExecutionCli: string;
  /** The data folder the server will use: env.GM_DATA_DIR, else <home>/.graph-manager. Only read here (password file). */
  dataDir: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  electron: boolean;
  fork?: typeof nodeFork;
  /** Default 30000. */
  startTimeoutMs?: number;
}

export interface RunningServer {
  port: number;
  pid: number;
  origin: string;
  /** Resolves with the exit code when the server process exits. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

/** Thrown when another graph-manager already runs on the data folder. */
export class AlreadyRunning extends Error {
  constructor(
    readonly port: number,
    readonly pid: number,
    /** `https` when that server serves TLS (`GM_TLS_CERT`/`GM_TLS_KEY`). */
    readonly scheme: "http" | "https" = "http",
  ) {
    super(`graph-manager is already running on this computer (port ${port})`);
    this.name = "AlreadyRunning";
  }
}

const STOP_WAIT_MS = 5000;
const PASSWORD_FILE = "password";

/** The env for the server child. */
export function serverEnv(env: NodeJS.ProcessEnv, graphExecutionCli: string, electron: boolean): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  // The server uses its saved password file and its default port (7420), like `npm start`.
  delete out.GM_PASSWORD;
  delete out.GM_PORT;
  // The app logs in and loads the UI over plain http on 127.0.0.1, so its own server never serves TLS.
  delete out.GM_TLS_CERT;
  delete out.GM_TLS_KEY;
  delete out.ELECTRON_RUN_AS_NODE;
  out.GM_HOST = "127.0.0.1";
  out.GM_PORT_FALLBACK = "1";
  out.GM_GRAPH_EXECUTION_BIN = graphExecutionCli;
  if (electron) out.ELECTRON_RUN_AS_NODE = "1";
  return out;
}

/** The data folder local mode uses: env.GM_DATA_DIR (resolved), else path.join(home, ".graph-manager"). */
export function localDataDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.GM_DATA_DIR ? path.resolve(env.GM_DATA_DIR) : path.join(home, ".graph-manager");
}

/** The workspaces folder: env.GM_WORKSPACES_DIR (resolved), else path.join(home, "graph-manager-workspaces"). */
export function localWorkspacesDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.GM_WORKSPACES_DIR ? path.resolve(env.GM_WORKSPACES_DIR) : path.join(home, "graph-manager-workspaces");
}

/** The trimmed content of <dataDir>/password; throws "no password file in <dataDir>" when missing or blank. */
export function readLocalPassword(dataDir: string): string {
  let pw = "";
  try {
    pw = readFileSync(path.join(dataDir, PASSWORD_FILE), "utf8").trim();
  } catch {
    // handled below
  }
  if (!pw) throw new Error(`no password file in ${dataDir}`);
  return pw;
}

/** POSTs the password to /api/auth/login and returns the gm_session cookie value; throws with the status on failure. */
export async function loginCookie(origin: string, password: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  // No Origin header: the server's same-origin check allows requests without one.
  const res = await fetchImpl(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 204) {
    for (const c of res.headers.getSetCookie()) {
      const first = c.split(";")[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0 && first.slice(0, eq).trim() === "gm_session") {
        const value = first.slice(eq + 1).trim();
        if (value) return value;
      }
    }
  }
  throw new Error(`login failed: HTTP ${res.status}`);
}

/** The last n lines of a log file ("" when missing). */
export function logTail(file: string, n = 20): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** Renames <file> to <file>.1 when it is larger than maxBytes (5 MB). */
export function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): void {
  try {
    if (statSync(file).size <= maxBytes) return;
  } catch {
    return;
  }
  const old = `${file}.1`;
  if (existsSync(old)) rmSync(old, { force: true });
  renameSync(file, old);
}

/** Forks graph-manager and resolves when it reports its port; rejects with AlreadyRunning, or with the log tail if it exits or times out first. */
export async function startLocalServer(o: LocalServerOptions): Promise<RunningServer> {
  const fork = o.fork ?? nodeFork;
  mkdirSync(path.dirname(o.logFile), { recursive: true });
  rotateLog(o.logFile);
  const log = createWriteStream(o.logFile, { flags: "a" });
  await new Promise<void>((resolve, reject) => {
    log.once("open", () => resolve());
    log.once("error", reject);
  });
  log.write(`--- ${new Date().toISOString()} starting ${o.serverEntry}\n`);

  let child: ChildProcess;
  try {
    child = fork(o.serverEntry, [], {
      execPath: o.execPath,
      env: serverEnv(o.env, o.graphExecutionCli, o.electron),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (err) {
    log.end();
    throw new Error(`graph-manager did not start:\n${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  const exited = new Promise<number | null>((resolve) => {
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      log.end();
      resolve(code);
    };
    // "close" comes after "exit" once stdout and stderr are drained, so the log has all of the output.
    child.once("close", (code) => finish(code));
    child.once("error", (err) => {
      log.write(`fork failed: ${err.message}\n`);
      if (child.exitCode !== null || child.pid === undefined) finish(child.exitCode);
    });
  });
  const flushedTail = async (): Promise<string> => {
    if (!log.writableFinished) await new Promise<void>((r) => log.once("finish", () => r()));
    return logTail(o.logFile);
  };

  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      void exited.then(flushedTail).then((tail) => reject(new Error(`graph-manager did not start:\n${tail}`)));
    }, o.startTimeoutMs ?? 30000);
    child.on("message", (msg: unknown) => {
      if (settled || !msg || typeof msg !== "object") return;
      const m = msg as { type?: unknown; port?: unknown; pid?: unknown; scheme?: unknown };
      if (m.type === "listening" && typeof m.port === "number") {
        settled = true;
        clearTimeout(timer);
        resolve(m.port);
      } else if (m.type === "already-running" && typeof m.port === "number") {
        settled = true;
        clearTimeout(timer);
        const err = new AlreadyRunning(m.port, typeof m.pid === "number" ? m.pid : 0, m.scheme === "https" ? "https" : "http");
        // The child exits with code 3 by itself.
        void exited.then(() => reject(err));
      }
    });
    void exited.then(async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`graph-manager did not start:\n${await flushedTail()}`));
    });
  });

  const pid = child.pid ?? 0;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // IPC on every OS: the server closes cleanly and removes server.lock (SIGTERM on Windows would not run its handler).
      if (child.connected) {
        try {
          child.send({ type: "shutdown" });
        } catch {
          // The channel closed meanwhile; force below.
        }
      }
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), STOP_WAIT_MS).unref());
      if ((await Promise.race([exited, timeout])) === "timeout") {
        if (process.platform === "win32") {
          // /T also ends the terminals and runs the server started.
          execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
        } else {
          child.kill("SIGKILL");
        }
        await exited;
      }
    })();
    return stopping;
  };

  return { port, pid, origin: `http://127.0.0.1:${port}`, exited, stop };
}
