import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pty, { type IPty } from "node-pty";
import { REVIEWERS_ENV } from "graph-execution/api";

export type TerminalStatus = "working" | "idle" | "exited";

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  /** Set when opened on a project (`POST /api/terminals { projectId }`): cwd is the project folder. */
  projectId?: string;
  /** The agent this terminal was opened with (`POST /api/terminals { agent }`). */
  agent?: string;
  status: TerminalStatus;
  exitCode?: number;
  createdAt: string;
  lastOutputAt?: string;
  /** The foreground process name (node-pty's `process`), e.g. `bash` or `node`; absent once exited. */
  process?: string;
  /** While working: when the current output burst started. */
  workingSince?: string;
}

export interface CreateTerminal {
  cwd: string;
  title?: string;
  workspaceId?: string;
  /** Shown in TerminalInfo. */
  projectId?: string;
  cols?: number;
  rows?: number;
  /** argv run instead of the shell (tests). */
  command?: string[];
  /** Shown in TerminalInfo. */
  agent?: string;
  /** Added to this terminal's env at spawn and on restart. */
  env?: Record<string, string>;
  /** Written to the PTY right after spawn, and again after each restart (e.g. the agent's command line). */
  input?: string;
}

export interface Attachment {
  write(s: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  /** The scrollback at attach time. */
  replay: string;
}

export interface TerminalManagerOptions {
  workspacesDir: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  /** Prepended to PATH; holds the `graph-execution` shim. */
  binDir?: string;
  /** Set as GRAPH_EXECUTION_REVIEWERS in every terminal. */
  reviewersFile?: string;
  /** Variables added to every terminal at spawn time (e.g. graph-manager's internal URL, known once listening). */
  extraEnv?: () => Record<string, string>;
  /** The platform the PATH variable is built for; `process.platform` by default. */
  platform?: NodeJS.Platform;
}

interface Listener {
  onData: (chunk: string) => void;
  onExit: (code: number) => void;
  onRestart?: () => void;
}

interface Term {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  projectId?: string;
  agent?: string;
  env?: Record<string, string>;
  input?: string;
  createdAt: Date;
  lastOutputAt?: Date;
  /** The first output after a quiet spell of WORKING_MS or more. */
  burstAt?: Date;
  exitCode?: number;
  proc: IPty;
  /** The argv spawned, reused by `restart`. */
  argv: [string, ...string[]];
  cols: number;
  rows: number;
  chunks: string[];
  size: number;
  listeners: Set<Listener>;
}

/** Output in the last WORKING_MS makes a terminal `working`. */
export const WORKING_MS = 3000;
/** Scrollback kept per terminal, in UTF-16 code units (close enough to bytes for terminal output). */
export const SCROLLBACK_MAX = 256 * 1024;

// GM_INTERNAL_*, GM_TERMINAL_ID, GM_PROJECT_ID: an outer graph-manager's (when started from one of its terminals); `extraEnv` and
// `spawn` set this server's.
const STRIPPED_ENV = ["GM_PASSWORD", "GM_EXTENSION_SECRET", "GM_INTERNAL_TOKEN", "GM_INTERNAL_URL", "GM_TERMINAL_ID", "GM_PROJECT_ID", "GM_ENGINE_BIN", "GRAPH_EXECUTION_RUN_ID", "GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE"];

/**
 * The session and runtime variables a coding agent sets for its own child processes. When graph-manager is started
 * from inside an agent (for example by asking Claude Code to run the dev server), terminals would inherit them, and an
 * agent opened in the terminal would take itself for part of the parent's session: Claude Code then saves the
 * conversation where `/resume` does not list it.
 */
const AGENT_SESSION_ENV = /^(CLAUDECODE$|CLAUDE_|CCR_|CODEX_SANDBOX|CODEX_THREAD_ID$|OPENCODE$|OPENCODE_SERVER|QWEN_CODE$)/;
/** User settings and credentials that match AGENT_SESSION_ENV but must reach the agents. */
const AGENT_KEPT_ENV = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return "powershell.exe";
  if (env.SHELL) return env.SHELL;
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * The environment of a terminal: `base` without secrets, run ids and a parent agent's session variables, plus the
 * graph-execution handoff settings.
 */
export function terminalEnv(
  base: NodeJS.ProcessEnv,
  binDir?: string,
  reviewersFile?: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || (AGENT_SESSION_ENV.test(k) && !AGENT_KEPT_ENV.has(k))) continue;
    env[k] = v;
  }
  for (const k of STRIPPED_ENV) delete env[k];
  env.TERM = "xterm-256color";
  env.GRAPH_EXECUTION_HANDOFF = "detached";
  env.SSH_CONNECTION = "1";
  if (reviewersFile) env[REVIEWERS_ENV] = reviewersFile;
  if (binDir) {
    const win = platform === "win32";
    // Windows env names are case-insensitive and `Path` is the usual spelling: a second `PATH` key would hide it.
    const key = (win ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") : undefined) ?? "PATH";
    const delimiter = win ? path.win32.delimiter : path.posix.delimiter;
    env[key] = env[key] ? `${binDir}${delimiter}${env[key]}` : binDir;
  }
  return env;
}

/** `cmd.exe` expands `%` and a `"` ends the quoting, so a path with either (or a line break) cannot go in a `.cmd` file. */
const CMD_UNSAFE = /[%"\r\n]/;

/** A `.cmd` file running `js` with node, with GM_ENGINE_BIN set to `engineBin` when given. CRLF line ends. */
function cmdShim(js: string, engineBin?: string): string {
  const lines = ["@echo off"];
  // `setlocal`: in an interactive cmd.exe the variable would otherwise stay set in the user's session.
  if (engineBin !== undefined) lines.push("setlocal", `set "GM_ENGINE_BIN=${engineBin}"`);
  lines.push(`node "${js}" %*`, "exit /b %ERRORLEVEL%");
  return lines.map((l) => `${l}\r\n`).join("");
}

/**
 * Writes `<binDir>/graph-execution` running `bin` with node, when `bin` is an absolute `.js` path. With `shimJs` (an
 * existing file), the command runs graph-manager's shim instead, which runs `bin` or handles `--sandbox` (KAN-88).
 * On Windows the file is `graph-execution.cmd`, and nothing is written (false) for a path with `%`, `"` or a line
 * break.
 */
export function writeGraphExecutionShim(binDir: string, bin: string, shimJs?: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(bin) || !bin.endsWith(".js")) return false;
  const useShim = shimJs !== undefined && existsSync(shimJs);
  if (platform === "win32") {
    if (CMD_UNSAFE.test(bin) || (useShim && CMD_UNSAFE.test(shimJs))) return false;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "graph-execution.cmd"), useShim ? cmdShim(shimJs, bin) : cmdShim(bin));
    return true;
  }
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "graph-execution");
  const content = useShim
    ? `#!/bin/sh\nGM_ENGINE_BIN=${JSON.stringify(bin)} exec node ${JSON.stringify(shimJs)} "$@"\n`
    : `#!/bin/sh\nexec node ${JSON.stringify(bin)} "$@"\n`;
  writeFileSync(file, content, { mode: 0o755 });
  chmodSync(file, 0o755);
  return true;
}

/**
 * Writes `<binDir>/graph-manager-mcp` running `mcpJs` with node; false when mcpJs is missing. On Windows the file is
 * `graph-manager-mcp.cmd`, and nothing is written (false) for a path with `%`, `"` or a line break.
 */
export function writeMcpShim(binDir: string, mcpJs: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(mcpJs)) return false;
  if (platform === "win32") {
    if (CMD_UNSAFE.test(mcpJs)) return false;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "graph-manager-mcp.cmd"), cmdShim(mcpJs));
    return true;
  }
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "graph-manager-mcp");
  writeFileSync(file, `#!/bin/sh\nexec node ${JSON.stringify(mcpJs)} "$@"\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return true;
}

/** `restart` of a terminal whose process still runs. */
export class TerminalRunningError extends Error {
  constructor(id: string) {
    super(`terminal ${id} is still running`);
  }
}

export class TerminalManager {
  private readonly terms = new Map<string, Term>();
  private counter = 0;
  private readonly shell: string;
  private readonly env: Record<string, string>;

  constructor(private readonly opts: TerminalManagerOptions) {
    this.shell = opts.shell ?? defaultShell(opts.env ?? process.env);
    this.env = terminalEnv(opts.env ?? process.env, opts.binDir, opts.reviewersFile, opts.platform);
  }

  create(p: CreateTerminal): TerminalInfo {
    const id = `t${++this.counter}`;
    const argv: [string, ...string[]] = p.command && p.command.length > 0 ? [p.command[0]!, ...p.command.slice(1)] : [this.shell];
    const cols = clamp(p.cols, 80);
    const rows = clamp(p.rows, 24);
    const term: Term = {
      id,
      title: p.title?.trim() || defaultTitle(this.opts.workspacesDir, p.cwd, p.workspaceId),
      cwd: p.cwd,
      workspaceId: p.workspaceId,
      projectId: p.projectId,
      agent: p.agent,
      env: p.env,
      input: p.input,
      createdAt: new Date(),
      proc: this.spawn(id, argv, p.cwd, cols, rows, p.env, p.input),
      argv,
      cols,
      rows,
      chunks: [],
      size: 0,
      listeners: new Set(),
    };
    this.wire(term);
    this.terms.set(id, term);
    return info(term);
  }

  private spawn(
    id: string,
    argv: [string, ...string[]],
    cwd: string,
    cols: number,
    rows: number,
    termEnv?: Record<string, string>,
    input?: string,
  ): IPty {
    const [file, ...args] = argv;
    // GM_TERMINAL_ID: which terminal a `graph-manager-mcp` process in it belongs to.
    const env = { ...this.env, ...this.opts.extraEnv?.(), ...termEnv, GM_TERMINAL_ID: id };
    const proc = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env });
    // The PTY buffers it until the shell reads.
    if (input) proc.write(input);
    return proc;
  }

  /** Connects the current process's output and exit to the scrollback and the listeners. */
  private wire(term: Term): void {
    const proc = term.proc;
    proc.onData((chunk) => {
      if (term.proc !== proc) return;
      const now = new Date();
      if (!term.lastOutputAt || now.getTime() - term.lastOutputAt.getTime() >= WORKING_MS) term.burstAt = now;
      term.lastOutputAt = now;
      term.chunks.push(chunk);
      term.size += chunk.length;
      while (term.size > SCROLLBACK_MAX && term.chunks.length > 0) {
        const over = term.size - SCROLLBACK_MAX;
        const first = term.chunks[0]!;
        if (first.length <= over) {
          term.chunks.shift();
          term.size -= first.length;
        } else {
          term.chunks[0] = first.slice(over);
          term.size -= over;
        }
      }
      for (const l of term.listeners) l.onData(chunk);
    });
    proc.onExit(({ exitCode }) => {
      if (term.proc !== proc) return;
      term.exitCode = exitCode;
      // Listeners stay registered: a restart sends the new process's output to them.
      for (const l of [...term.listeners]) l.onExit(exitCode);
    });
  }

  /**
   * Starts a new process in an exited terminal: same argv, cwd, env, title, workspace and size. The scrollback stays
   * (with a line break so the new output starts on a fresh line) and attached listeners get the new output.
   * Throws `TerminalRunningError` while the process still runs; returns undefined for an unknown id.
   */
  restart(id: string): TerminalInfo | undefined {
    const term = this.terms.get(id);
    if (!term) return undefined;
    if (term.exitCode === undefined) throw new TerminalRunningError(id);
    term.chunks.push("\r\n");
    term.size += 2;
    term.proc = this.spawn(term.id, term.argv, term.cwd, term.cols, term.rows, term.env, term.input);
    term.exitCode = undefined;
    term.lastOutputAt = undefined;
    term.burstAt = undefined;
    this.wire(term);
    for (const l of [...term.listeners]) l.onRestart?.();
    return info(term);
  }

  /** Renames a terminal; returns undefined for an unknown id. */
  rename(id: string, title: string): TerminalInfo | undefined {
    const term = this.terms.get(id);
    if (!term) return undefined;
    term.title = title.trim() || term.title;
    return info(term);
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map(info);
  }

  get(id: string): TerminalInfo | undefined {
    const t = this.terms.get(id);
    return t ? info(t) : undefined;
  }

  /** Listens to a terminal until `detach`, across exits and restarts. An exited terminal reports its exit code right away. */
  attach(id: string, onData: (chunk: string) => void, onExit: (code: number) => void, onRestart?: () => void): Attachment {
    const term = this.terms.get(id);
    if (!term) throw new Error(`unknown terminal ${id}`);
    const listener: Listener = { onData, onExit, onRestart };
    const replay = term.chunks.join("");
    term.listeners.add(listener);
    if (term.exitCode !== undefined) {
      const code = term.exitCode;
      queueMicrotask(() => {
        if (term.listeners.has(listener) && term.exitCode === code) onExit(code);
      });
    }
    return {
      replay,
      write: (s) => {
        if (term.exitCode === undefined) term.proc.write(s);
      },
      resize: (c, r) => {
        term.cols = clamp(c, 80);
        term.rows = clamp(r, 24);
        if (term.exitCode !== undefined) return;
        try {
          term.proc.resize(term.cols, term.rows);
        } catch {
          // the process may have just exited
        }
      },
      detach: () => {
        term.listeners.delete(listener);
      },
    };
  }

  /** Stops the process; the record stays listed as exited until removed. */
  kill(id: string): void {
    const term = this.terms.get(id);
    if (!term || term.exitCode !== undefined) return;
    try {
      term.proc.kill(process.platform === "win32" ? undefined : "SIGHUP");
    } catch {
      // already gone
    }
  }

  /** Kills the terminal if it runs and forgets it. */
  remove(id: string): boolean {
    const term = this.terms.get(id);
    if (!term) return false;
    this.kill(id);
    term.listeners.clear();
    this.terms.delete(id);
    return true;
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.remove(id);
  }
}

function clamp(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(1000, Math.max(2, Math.floor(n)));
}

function defaultTitle(root: string, cwd: string, workspaceId?: string): string {
  if (workspaceId) return workspaceId.split("~").slice(1).join("/") || workspaceId;
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  return rel === "" ? "workspaces" : rel.split(path.sep).join("/");
}

function info(t: Term): TerminalInfo {
  const exited = t.exitCode !== undefined;
  const working = !exited && t.lastOutputAt !== undefined && Date.now() - t.lastOutputAt.getTime() < WORKING_MS;
  return {
    id: t.id,
    title: t.title,
    cwd: t.cwd,
    ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    ...(t.agent ? { agent: t.agent } : {}),
    status: exited ? "exited" : working ? "working" : "idle",
    ...(exited ? { exitCode: t.exitCode } : {}),
    createdAt: t.createdAt.toISOString(),
    ...(t.lastOutputAt ? { lastOutputAt: t.lastOutputAt.toISOString() } : {}),
    ...(working && t.burstAt ? { workingSince: t.burstAt.toISOString() } : {}),
    ...(exited ? {} : processOf(t.proc)),
  };
}

function processOf(proc: IPty): { process?: string } {
  try {
    const name = proc.process;
    return typeof name === "string" && name !== "" ? { process: path.basename(name) } : {};
  } catch {
    return {};
  }
}
