import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { execa, type ResultPromise } from "execa";
import { RUN_ENV_UNSET } from "../state/paths.js";
import type { ProcessHooks } from "./types.js";
import { killLeftovers } from "./wintree.js";

export interface SpawnOptions {
  cwd: string;
  signal: AbortSignal;
  /**
   * Written to the agent's stdin, which is then closed; empty when absent. Prompts go this way, not on the command
   * line: on Windows the CLIs are `.cmd` shims run through `cmd.exe`, which caps a command line at 8191 characters
   * and gives special meaning to characters like `%`, `^`, `&` and newlines.
   */
  input?: string;
  /** Told the agent's pid as soon as it is spawned and again once it exited (and its group was signalled). */
  processHooks?: ProcessHooks;
}

export interface SpawnedAgent {
  child: ResultPromise<{
    cwd: string;
    env: typeof RUN_ENV_UNSET & { PWD: string };
    detached: boolean;
    reject: false;
    input: string;
    all: true;
    buffer: false;
    stdout: ReturnType<typeof capLines>;
    stderr: ReturnType<typeof capLines>;
  }>;
  /** Resolves with the exit code; a child killed by a signal reports 1. Rejects if the process could not start. */
  exitCode: Promise<number>;
}

export const WINDOWS = process.platform === "win32";

/** Longest output line kept, in characters; the rest of a longer line is dropped and counted. */
export const MAX_LINE_CHARS = 1 << 20;

/**
 * An execa binary transform that splits a stream into lines itself and truncates every line over `max` characters,
 * ending it with ` [truncated N characters]`. Memory per stream stays at most one capped line plus one chunk.
 */
export function capLines(max = MAX_LINE_CHARS) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropped = 0;
  const take = (text: string): void => {
    const room = max - pending.length;
    if (text.length > room) {
      dropped += text.length - room;
      pending += text.slice(0, room);
    } else pending += text;
  };
  const line = (): string => {
    const out = dropped > 0 ? `${pending} [truncated ${dropped} characters]\n` : `${pending}\n`;
    pending = "";
    dropped = 0;
    return out;
  };
  return {
    binary: true,
    *transform(chunk: unknown): Generator<string> {
      let text = decoder.write(chunk as Buffer);
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n")) {
        take(text.slice(0, i));
        text = text.slice(i + 1);
        yield line();
      }
      take(text);
    },
    *final(): Generator<string> {
      take(decoder.end());
      if (pending !== "" || dropped > 0) yield line();
    },
  } as const;
}

/**
 * Kills the agent and every process it started. POSIX: the agent leads its own process group, signalled as a whole.
 * Windows has no process groups to signal, so `taskkill /T` walks the process tree from the agent's PID instead.
 */
export function killTree(pid: number): Promise<void> {
  if (WINDOWS) {
    return execa("taskkill", ["/pid", String(pid), "/T", "/F"], { reject: false, stdio: "ignore" }).then(() => undefined);
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The group is already gone.
  }
  return Promise.resolve();
}

/**
 * Spawns an agent process so that aborting `signal` kills the agent and every process it started (PRD §7.7).
 * Agents run until they exit or `signal` aborts; `watchIdle` (src/agents/idle.ts) aborts an agent that stays silent for
 * `idleTimeoutMinutes`.
 * On POSIX the agent gets its own process group, and once it exits, whatever it left running in that group (e.g. an
 * app the live tester booted) is killed too. Windows has no groups: once the agent exits, its leftovers are found in
 * the process table through their parent PIDs and creation times (`killLeftovers`). `detached` is left off there, as
 * it would give every console program the agent starts its own window.
 * `PWD` is set to the worktree: a child otherwise inherits ours (the repo root), and some CLIs (opencode) take their
 * working directory from `PWD` rather than the real cwd, so they would edit and commit in the user's checkout.
 * The run's own variables (`RUN_ENV_UNSET`) are not passed on.
 * The process is reported to `processHooks` right after the spawn (synchronously) and after it exited, so a later
 * `--resume`/`clean` can kill it if this CLI dies without cleaning up (`kill -9`, the OOM killer).
 */
export function spawnAgent(file: string, args: string[], opts: SpawnOptions): SpawnedAgent {
  const child = execa(file, args, {
    cwd: opts.cwd,
    env: { ...RUN_ENV_UNSET, PWD: opts.cwd },
    detached: !WINDOWS,
    reject: false,
    input: opts.input ?? "",
    all: true,
    // Output is only read line by line through `child.iterable()`, and every line goes to the agent's log file.
    // Buffered, execa would also keep it all in memory (stdout, stderr and again `all`, up to 100 MB each) for as long
    // as the agent runs: a long run's agents filled the heap, and one past `maxBuffer` was killed.
    // `capLines` splits each stream into lines and truncates a single line longer than `MAX_LINE_CHARS`, so a provider
    // that prints without newlines cannot fill the heap either. One transform per stream: each keeps its own partial line.
    buffer: false,
    stdout: capLines(),
    stderr: capLines(),
  });
  const pid = child.pid;
  const startedAt = Date.now();
  if (pid !== undefined) {
    try {
      opts.processHooks?.started(pid, file);
    } catch {
      // Bookkeeping never breaks a spawn.
    }
  }
  let killing: Promise<void> | undefined;
  const kill = (): void => {
    if (child.pid === undefined) return;
    // POSIX signals the group again on exit, for what it left behind; Windows needs a single taskkill.
    if (WINDOWS) killing ??= killTree(child.pid);
    else void killTree(child.pid);
  };
  if (opts.signal.aborted) kill();
  else opts.signal.addEventListener("abort", kill, { once: true });
  const exitCode = child.then(async (res) => {
    opts.signal.removeEventListener("abort", kill);
    if (!WINDOWS) kill();
    // Windows: `taskkill /T` needs a live PID, so an abort's taskkill is awaited, then the leftovers that outlived the
    // agent (orphans still name it as their parent) are killed from the process table.
    await killing;
    if (WINDOWS && pid !== undefined) await killLeftovers(pid, startedAt, Date.now());
    if (pid !== undefined) {
      try {
        opts.processHooks?.exited(pid);
      } catch {
        // Bookkeeping never breaks a spawn.
      }
    }
    // No exit code and no signal: the process never started (e.g. ENOENT).
    if (res.failed && res.exitCode === undefined && res.signal === undefined) {
      throw new Error(`failed to start "${file}": ${res.originalMessage || res.shortMessage}`, { cause: res });
    }
    // Windows runs a CLI's `.cmd` shim through cmd.exe, which exits 1 when there is nothing to run instead of failing
    // the spawn: report that the same way. Imported here, not at the top: ./index.js imports the providers, which
    // import this module.
    if (WINDOWS && res.exitCode === 1 && !path.isAbsolute(file)) {
      const { findOnPath } = await import("./index.js");
      if (findOnPath(file, opts.cwd) === undefined) {
        throw new Error(`failed to start "${file}": spawn ${file} ENOENT (not found on the PATH)`, { cause: res });
      }
    }
    return res.exitCode ?? 1;
  });
  return { child, exitCode };
}
