import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pty, { type IPty } from "node-pty";

export type TerminalStatus = "working" | "idle" | "exited";

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  status: TerminalStatus;
  exitCode?: number;
  createdAt: string;
  lastOutputAt?: string;
}

export interface CreateTerminal {
  cwd: string;
  title?: string;
  workspaceId?: string;
  cols?: number;
  rows?: number;
  /** argv run instead of the shell (tests). */
  command?: string[];
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
}

interface Listener {
  onData: (chunk: string) => void;
  onExit: (code: number) => void;
}

interface Term {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  createdAt: Date;
  lastOutputAt?: Date;
  exitCode?: number;
  proc: IPty;
  chunks: string[];
  size: number;
  listeners: Set<Listener>;
}

/** Output in the last WORKING_MS makes a terminal `working`. */
export const WORKING_MS = 3000;
/** Scrollback kept per terminal, in UTF-16 code units (close enough to bytes for terminal output). */
export const SCROLLBACK_MAX = 256 * 1024;

const STRIPPED_ENV = ["GM_PASSWORD", "GRAPH_EXECUTION_RUN_ID", "GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE"];

export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return "powershell.exe";
  if (env.SHELL) return env.SHELL;
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** The environment of a terminal: `base` without secrets and run ids, plus the graph-execution handoff settings. */
export function terminalEnv(base: NodeJS.ProcessEnv, binDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const k of STRIPPED_ENV) delete env[k];
  env.TERM = "xterm-256color";
  env.GRAPH_EXECUTION_HANDOFF = "detached";
  env.SSH_CONNECTION = "1";
  if (binDir) env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
  return env;
}

/** Writes `<binDir>/graph-execution` running `bin` with node, when `bin` is an absolute `.js` path. */
export function writeGraphExecutionShim(binDir: string, bin: string): boolean {
  if (!path.isAbsolute(bin) || !bin.endsWith(".js") || process.platform === "win32") return false;
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "graph-execution");
  writeFileSync(file, `#!/bin/sh\nexec node ${JSON.stringify(bin)} "$@"\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return true;
}

export class TerminalManager {
  private readonly terms = new Map<string, Term>();
  private counter = 0;
  private readonly shell: string;
  private readonly env: Record<string, string>;

  constructor(private readonly opts: TerminalManagerOptions) {
    this.shell = opts.shell ?? defaultShell(opts.env ?? process.env);
    this.env = terminalEnv(opts.env ?? process.env, opts.binDir);
  }

  create(p: CreateTerminal): TerminalInfo {
    const id = `t${++this.counter}`;
    const [file, ...args] = p.command && p.command.length > 0 ? p.command : [this.shell];
    const proc = pty.spawn(file!, args, {
      name: "xterm-256color",
      cols: clamp(p.cols, 80),
      rows: clamp(p.rows, 24),
      cwd: p.cwd,
      env: this.env,
    });
    const term: Term = {
      id,
      title: p.title?.trim() || defaultTitle(this.opts.workspacesDir, p.cwd, p.workspaceId),
      cwd: p.cwd,
      workspaceId: p.workspaceId,
      createdAt: new Date(),
      proc,
      chunks: [],
      size: 0,
      listeners: new Set(),
    };
    proc.onData((chunk) => {
      term.lastOutputAt = new Date();
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
      term.exitCode = exitCode;
      for (const l of [...term.listeners]) l.onExit(exitCode);
    });
    this.terms.set(id, term);
    return info(term);
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map(info);
  }

  get(id: string): TerminalInfo | undefined {
    const t = this.terms.get(id);
    return t ? info(t) : undefined;
  }

  attach(id: string, onData: (chunk: string) => void, onExit: (code: number) => void): Attachment {
    const term = this.terms.get(id);
    if (!term) throw new Error(`unknown terminal ${id}`);
    const listener: Listener = { onData, onExit };
    const replay = term.chunks.join("");
    if (term.exitCode === undefined) term.listeners.add(listener);
    else queueMicrotask(() => onExit(term.exitCode!));
    return {
      replay,
      write: (s) => {
        if (term.exitCode === undefined) term.proc.write(s);
      },
      resize: (c, r) => {
        if (term.exitCode !== undefined) return;
        try {
          term.proc.resize(clamp(c, 80), clamp(r, 24));
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
    status: exited ? "exited" : working ? "working" : "idle",
    ...(exited ? { exitCode: t.exitCode } : {}),
    createdAt: t.createdAt.toISOString(),
    ...(t.lastOutputAt ? { lastOutputAt: t.lastOutputAt.toISOString() } : {}),
  };
}
