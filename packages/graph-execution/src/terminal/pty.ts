// One PTY process with a scrollback ring buffer, shared by graph-manager's Terminals and the engine's own terminals.
// node-pty is a native module that the CLI's normal path and sandboxed runs must never load: this file imports only
// its types, and `createPtySession` loads it on first use.
import type { IPty } from "node-pty";

/** Scrollback kept per terminal, in UTF-16 code units (close enough to bytes for terminal output). */
export const SCROLLBACK_MAX = 256 * 1024;

/** The part of the node-pty module a session uses (`import pty from "node-pty"` fits). */
export interface PtyModule {
  spawn(file: string, args: string[] | string, options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string | undefined> }): IPty;
}

export interface PtySessionOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /** Written to the PTY right after spawn, and again after each restart (the PTY buffers it until the shell reads). */
  input?: string;
  /** Called for every output chunk, before the listeners get it (graph-manager's working/idle status). */
  onActivity?: (chunk: string) => void;
}

export interface PtyListener {
  data(chunk: string): void;
  exit(code: number): void;
  restart?(): void;
}

export interface PtyAttachment {
  write(s: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  /** The scrollback at attach time. */
  replay: string;
}

export interface PtySession {
  /** Listens until `detach`, across exits and restarts. An exited session reports its exit code right away (in a microtask). */
  attach(listener: PtyListener): PtyAttachment;
  /** Stops the process (SIGHUP; the default signal on Windows). Nothing when it already exited. */
  kill(signal?: string): void;
  /**
   * Starts a new process with the same argv, cwd and size (and `env` when given). The scrollback stays, with a line
   * break so the new output starts on a fresh line; attached listeners get `restart` and then the new output.
   * Throws while the process still runs.
   */
  restart(o?: { env?: NodeJS.ProcessEnv }): void;
  /** Drops every listener (the terminal is being closed). */
  detachAll(): void;
  readonly exited: boolean;
  readonly exitCode: number | undefined;
  readonly pid: number;
  /** The foreground process name (node-pty's `process`); undefined when unknown. */
  readonly process: string | undefined;
  readonly cols: number;
  readonly rows: number;
}

/** A PTY session; loads node-pty on first use. */
export async function createPtySession(o: PtySessionOptions): Promise<PtySession> {
  const mod = (await import("node-pty")) as unknown as PtyModule & { default?: PtyModule };
  return createPtySessionSync(mod.default ?? mod, o);
}

/** A PTY session on an already loaded node-pty (graph-manager loads it at startup and spawns synchronously). */
export function createPtySessionSync(pty: PtyModule, o: PtySessionOptions): PtySession {
  const listeners = new Set<PtyListener>();
  const chunks: string[] = [];
  let size = 0;
  let cols = clamp(o.cols, 80);
  let rows = clamp(o.rows, 24);
  let env = o.env;
  let exitCode: number | undefined;

  const spawn = (): IPty => {
    const proc = pty.spawn(o.file, o.args, { name: "xterm-256color", cols, rows, cwd: o.cwd, env });
    if (o.input) proc.write(o.input);
    return proc;
  };

  /** Connects the current process's output and exit to the scrollback and the listeners. */
  const wire = (p: IPty): void => {
    p.onData((chunk) => {
      if (proc !== p) return;
      o.onActivity?.(chunk);
      chunks.push(chunk);
      size += chunk.length;
      while (size > SCROLLBACK_MAX && chunks.length > 0) {
        const over = size - SCROLLBACK_MAX;
        const first = chunks[0]!;
        if (first.length <= over) {
          chunks.shift();
          size -= first.length;
        } else {
          chunks[0] = first.slice(over);
          size -= over;
        }
      }
      for (const l of listeners) l.data(chunk);
    });
    p.onExit(({ exitCode: code }) => {
      if (proc !== p) return;
      exitCode = code;
      // Listeners stay registered: a restart sends the new process's output to them.
      for (const l of [...listeners]) l.exit(code);
    });
  };

  let proc = spawn();
  wire(proc);

  return {
    attach(listener) {
      const replay = chunks.join("");
      listeners.add(listener);
      if (exitCode !== undefined) {
        const code = exitCode;
        queueMicrotask(() => {
          if (listeners.has(listener) && exitCode === code) listener.exit(code);
        });
      }
      return {
        replay,
        write: (s) => {
          if (exitCode === undefined) proc.write(s);
        },
        resize: (c, r) => {
          cols = clamp(c, 80);
          rows = clamp(r, 24);
          if (exitCode !== undefined) return;
          try {
            proc.resize(cols, rows);
          } catch {
            // the process may have just exited
          }
        },
        detach: () => {
          listeners.delete(listener);
        },
      };
    },
    kill(signal) {
      if (exitCode !== undefined) return;
      try {
        proc.kill(signal ?? (process.platform === "win32" ? undefined : "SIGHUP"));
      } catch {
        // already gone
      }
    },
    restart(r) {
      if (exitCode === undefined) throw new Error("the process is still running");
      chunks.push("\r\n");
      size += 2;
      if (r?.env) env = r.env;
      proc = spawn();
      exitCode = undefined;
      wire(proc);
      for (const l of [...listeners]) l.restart?.();
    },
    detachAll() {
      listeners.clear();
    },
    get exited() {
      return exitCode !== undefined;
    },
    get exitCode() {
      return exitCode;
    },
    get pid() {
      return proc.pid;
    },
    get process() {
      try {
        const name = proc.process;
        return typeof name === "string" && name !== "" ? name : undefined;
      } catch {
        return undefined;
      }
    },
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
  };
}

/** A terminal dimension from a client: 2..1000, `fallback` when missing or not a number. */
export function clamp(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(1000, Math.max(2, Math.floor(n)));
}
