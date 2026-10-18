import { execa, type ResultPromise } from "execa";

export interface SpawnOptions {
  cwd: string;
  signal: AbortSignal;
}

export interface SpawnedAgent {
  child: ResultPromise<{ cwd: string; detached: boolean; reject: false; stdin: "ignore"; all: true }>;
  /** Resolves with the exit code; a child killed by a signal reports 1. Rejects if the process could not start. */
  exitCode: Promise<number>;
}

const WINDOWS = process.platform === "win32";

/**
 * Kills the agent and every process it started. POSIX: the agent leads its own process group, signalled as a whole.
 * Windows has no process groups to signal, so `taskkill /T` walks the process tree from the agent's PID instead.
 */
function killTree(pid: number): Promise<void> {
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
 * Agents run until they exit or are aborted; nothing stops them on a clock.
 * On POSIX the agent gets its own process group, and once it exits, whatever it left running in that group (e.g. an
 * app the live tester booted) is killed too. On Windows the tree is found through parent PIDs, so only what is still
 * attached to a running agent can be killed; `detached` is left off there, as it would give every console program the
 * agent starts its own window.
 */
export function spawnAgent(file: string, args: string[], opts: SpawnOptions): SpawnedAgent {
  const child = execa(file, args, { cwd: opts.cwd, detached: !WINDOWS, reject: false, stdin: "ignore", all: true });
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
    // Windows: the agent's PID is gone, so there is no tree left to walk; wait for an abort's taskkill to finish.
    if (!WINDOWS) kill();
    await killing;
    // No exit code and no signal: the process never started (e.g. ENOENT).
    if (res.failed && res.exitCode === undefined && res.signal === undefined) {
      throw new Error(`failed to start "${file}": ${res.originalMessage || res.shortMessage}`, { cause: res });
    }
    return res.exitCode ?? 1;
  });
  return { child, exitCode };
}
