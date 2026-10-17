import { execa, type ResultPromise } from "execa";

export interface SpawnOptions {
  cwd: string;
  signal: AbortSignal;
}

export interface SpawnedAgent {
  child: ResultPromise<{ cwd: string; detached: true; reject: false; stdin: "ignore"; all: true }>;
  /** Resolves with the exit code; a child killed by a signal reports 1. Rejects if the process could not start. */
  exitCode: Promise<number>;
}

/**
 * Spawns an agent process in its own process group so that aborting `signal` kills the agent and every
 * process it started (PRD §7.7). Agents run until they exit or are aborted; nothing stops them on a clock.
 * Once the agent exits, whatever it left running in its group (e.g. an app the live tester booted) is killed too.
 */
export function spawnAgent(file: string, args: string[], opts: SpawnOptions): SpawnedAgent {
  const child = execa(file, args, { cwd: opts.cwd, detached: true, reject: false, stdin: "ignore", all: true });
  const kill = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The group is already gone.
    }
  };
  if (opts.signal.aborted) kill();
  else opts.signal.addEventListener("abort", kill, { once: true });
  const exitCode = child.then((res) => {
    opts.signal.removeEventListener("abort", kill);
    kill();
    // No exit code and no signal: the process never started (e.g. ENOENT).
    if (res.failed && res.exitCode === undefined && res.signal === undefined) {
      throw new Error(`failed to start "${file}": ${res.originalMessage || res.shortMessage}`, { cause: res });
    }
    return res.exitCode ?? 1;
  });
  return { child, exitCode };
}
