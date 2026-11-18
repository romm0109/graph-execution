import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pty from "node-pty";
import { createPtySessionSync, REVIEWERS_ENV, SCROLLBACK_MAX, type PtyAttachment, type PtySession } from "graph-execution/api";
import { type NodeCommand, nodeCommand } from "./node.js";

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
  /** The terminal's own git worktree (terminals opened on a workspace). */
  worktree?: { id: string; path: string; branch: string };
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
  /** Shown in TerminalInfo: the worktree `cwd` is. */
  worktree?: { id: string; path: string; branch: string };
}

export type Attachment = PtyAttachment;

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

interface Term {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  projectId?: string;
  agent?: string;
  env?: Record<string, string>;
  input?: string;
  worktree?: { id: string; path: string; branch: string };
  createdAt: Date;
  lastOutputAt?: Date;
  /** The first output after a quiet spell of WORKING_MS or more. */
  burstAt?: Date;
  /** The PTY process, its scrollback and its listeners (the engine's shared terminal session). */
  session: PtySession;
}

/** Output in the last WORKING_MS makes a terminal `working`. */
export const WORKING_MS = 3000;
export { SCROLLBACK_MAX };

// GM_INTERNAL_*, GM_TERMINAL_ID, GM_PROJECT_ID: an outer graph-manager's (when started from one of its terminals); `extraEnv` and
// `spawn` set this server's. ELECTRON_RUN_AS_NODE: only for starting this server under Electron; it breaks the user's own
// Electron apps (VS Code's `code`).
const STRIPPED_ENV = ["ELECTRON_RUN_AS_NODE", "GM_PASSWORD", "GM_INTERNAL_TOKEN", "GM_INTERNAL_URL", "GM_TERMINAL_ID", "GM_PROJECT_ID", "GM_ENGINE_BIN", "GRAPH_EXECUTION_RUN_ID", "GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE"];

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

/** A `.cmd` file running `js` with `runtime` (absolute path), with GM_ENGINE_BIN set to `engineBin` when given. CRLF line ends. */
function cmdShim(runtime: NodeCommand, js: string, engineBin?: string): string {
  const lines = ["@echo off"];
  const vars = Object.entries(runtime.env);
  // `setlocal`: in an interactive cmd.exe the variables would otherwise stay set in the user's session.
  if (engineBin !== undefined || vars.length > 0) lines.push("setlocal");
  if (engineBin !== undefined) lines.push(`set "GM_ENGINE_BIN=${engineBin}"`);
  for (const [k, v] of vars) lines.push(`set "${k}=${v}"`);
  lines.push(`"${runtime.file}" "${js}" %*`, "exit /b %ERRORLEVEL%");
  return lines.map((l) => `${l}\r\n`).join("");
}

/** A `/bin/sh` script running `js` with `runtime` (absolute path), with GM_ENGINE_BIN set to `engineBin` when given. */
function shScript(runtime: NodeCommand, js: string, engineBin?: string): string {
  const engine = engineBin !== undefined ? `GM_ENGINE_BIN=${JSON.stringify(engineBin)} ` : "";
  // The values come only from nodeCommand() ("1"), so they need no quoting.
  const vars = Object.entries(runtime.env)
    .map(([k, v]) => `${k}=${v} `)
    .join("");
  return `#!/bin/sh\n${engine}${vars}exec ${JSON.stringify(runtime.file)} ${JSON.stringify(js)} "$@"\n`;
}

/**
 * Writes `<binDir>/graph-execution` running `bin` with this process's runtime (`nodeCommand()`: an absolute path, not
 * `node` from PATH), when `bin` is an absolute `.js` path. With `shimJs` (an
 * existing file), the command runs graph-manager's shim instead, which runs `bin` or handles `--sandbox` (KAN-88).
 * On Windows the file is `graph-execution.cmd`, and nothing is written (false) for a path with `%`, `"` or a line
 * break.
 */
export function writeGraphExecutionShim(
  binDir: string,
  bin: string,
  shimJs?: string,
  platform: NodeJS.Platform = process.platform,
  runtime: NodeCommand = nodeCommand(),
): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(bin) || !bin.endsWith(".js")) return false;
  const useShim = shimJs !== undefined && existsSync(shimJs);
  if (platform === "win32") {
    if (CMD_UNSAFE.test(runtime.file) || CMD_UNSAFE.test(bin) || (useShim && CMD_UNSAFE.test(shimJs))) return false;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "graph-execution.cmd"), useShim ? cmdShim(runtime, shimJs, bin) : cmdShim(runtime, bin));
    return true;
  }
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "graph-execution");
  const content = useShim ? shScript(runtime, shimJs, bin) : shScript(runtime, bin);
  writeFileSync(file, content, { mode: 0o755 });
  chmodSync(file, 0o755);
  return true;
}

/**
 * Writes `<binDir>/graph-manager-mcp` running `mcpJs` with this process's runtime (`nodeCommand()`: an absolute path,
 * not `node` from PATH); false when mcpJs is missing. On Windows the file is `graph-manager-mcp.cmd`, and nothing is written (false) for a path with `%`, `"` or a line break.
 */
export function writeMcpShim(
  binDir: string,
  mcpJs: string,
  platform: NodeJS.Platform = process.platform,
  runtime: NodeCommand = nodeCommand(),
): boolean {
  if (!existsSync(mcpJs)) return false;
  if (platform === "win32") {
    if (CMD_UNSAFE.test(runtime.file) || CMD_UNSAFE.test(mcpJs)) return false;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "graph-manager-mcp.cmd"), cmdShim(runtime, mcpJs));
    return true;
  }
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "graph-manager-mcp");
  writeFileSync(file, shScript(runtime, mcpJs), { mode: 0o755 });
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
    const term: Omit<Term, "session"> & { session?: PtySession } = {
      id,
      title: p.title?.trim() || defaultTitle(this.opts.workspacesDir, p.cwd, p.workspaceId),
      cwd: p.cwd,
      workspaceId: p.workspaceId,
      projectId: p.projectId,
      agent: p.agent,
      env: p.env,
      input: p.input,
      worktree: p.worktree,
      createdAt: new Date(),
    };
    const [file, ...args] = argv;
    term.session = createPtySessionSync(pty, {
      file,
      args,
      cwd: p.cwd,
      env: this.envOf(id, p.env),
      cols: p.cols,
      rows: p.rows,
      input: p.input,
      onActivity: () => {
        const now = new Date();
        if (!term.lastOutputAt || now.getTime() - term.lastOutputAt.getTime() >= WORKING_MS) term.burstAt = now;
        term.lastOutputAt = now;
      },
    });
    const t = term as Term;
    this.terms.set(id, t);
    return info(t);
  }

  private envOf(id: string, termEnv?: Record<string, string>): Record<string, string> {
    // GM_TERMINAL_ID: which terminal a `graph-manager-mcp` process in it belongs to.
    return { ...this.env, ...this.opts.extraEnv?.(), ...termEnv, GM_TERMINAL_ID: id };
  }

  /**
   * Starts a new process in an exited terminal: same argv, cwd, env, title, workspace and size. The scrollback stays
   * (with a line break so the new output starts on a fresh line) and attached listeners get the new output.
   * Throws `TerminalRunningError` while the process still runs; returns undefined for an unknown id.
   */
  restart(id: string): TerminalInfo | undefined {
    const term = this.terms.get(id);
    if (!term) return undefined;
    if (!term.session.exited) throw new TerminalRunningError(id);
    term.lastOutputAt = undefined;
    term.burstAt = undefined;
    term.session.restart({ env: this.envOf(term.id, term.env) });
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
    return term.session.attach({ data: onData, exit: onExit, restart: onRestart });
  }

  /** Stops the process; the record stays listed as exited until removed. */
  kill(id: string): void {
    const term = this.terms.get(id);
    term?.session.kill();
  }

  /** Kills the terminal if it runs and forgets it. */
  remove(id: string): boolean {
    const term = this.terms.get(id);
    if (!term) return false;
    this.kill(id);
    term.session.detachAll();
    this.terms.delete(id);
    return true;
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.remove(id);
  }
}

function defaultTitle(root: string, cwd: string, workspaceId?: string): string {
  if (workspaceId) return workspaceId.split("~").slice(1).join("/") || workspaceId;
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  return rel === "" ? "workspaces" : rel.split(path.sep).join("/");
}

function info(t: Term): TerminalInfo {
  const exited = t.session.exited;
  const working = !exited && t.lastOutputAt !== undefined && Date.now() - t.lastOutputAt.getTime() < WORKING_MS;
  return {
    id: t.id,
    title: t.title,
    cwd: t.cwd,
    ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    ...(t.agent ? { agent: t.agent } : {}),
    ...(t.worktree ? { worktree: t.worktree } : {}),
    status: exited ? "exited" : working ? "working" : "idle",
    ...(exited ? { exitCode: t.session.exitCode } : {}),
    createdAt: t.createdAt.toISOString(),
    ...(t.lastOutputAt ? { lastOutputAt: t.lastOutputAt.toISOString() } : {}),
    ...(working && t.burstAt ? { workingSince: t.burstAt.toISOString() } : {}),
    ...(exited ? {} : processOf(t.session)),
  };
}

function processOf(session: PtySession): { process?: string } {
  const name = session.process;
  return name !== undefined ? { process: path.basename(name) } : {};
}
