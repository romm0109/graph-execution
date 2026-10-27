import { setTimeout as delay } from "node:timers/promises";
import { execa, type ResultPromise } from "execa";
import { RUN_ENV_UNSET } from "../state/paths.js";
import { jobLaunch } from "./windows-job.js";

export interface SpawnOptions {
  cwd: string;
  signal: AbortSignal;
  /**
   * Written to the agent's stdin, which is then closed; empty when absent. Prompts go this way, not on the command
   * line: on Windows the CLIs are `.cmd` shims run through `cmd.exe`, which caps a command line at 8191 characters
   * and gives special meaning to characters like `%`, `^`, `&` and newlines.
   */
  input?: string;
}

export interface SpawnedAgent {
  child: ResultPromise<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
    reject: false;
    input: string;
    all: true;
    buffer: false;
  }>;
  /** Resolves with the exit code; a child killed by a signal reports 1. Rejects if the process could not start. */
  exitCode: Promise<number>;
}

const WINDOWS = process.platform === "win32";

/** How long a POSIX process group gets to exit after `SIGTERM` before it is sent `SIGKILL`. */
export const KILL_GRACE_MS = 2000;

/** True while any process of group `pgid` is alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills the agent and every process it started. POSIX: the agent leads its own process group, sent `SIGTERM` and,
 * whatever is still alive after `KILL_GRACE_MS`, `SIGKILL`. Windows: `taskkill /T` kills the job launcher and the
 * agent below it; closing the launcher's job kills everything else the agent started (see `windows-job.ts`).
 */
async function killTree(pid: number): Promise<void> {
  if (WINDOWS) {
    await execa("taskkill", ["/pid", String(pid), "/T", "/F"], { reject: false, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // The group is already gone.
  }
  for (let waited = 0; waited < KILL_GRACE_MS && groupAlive(pid); waited += 100) await delay(100);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Everything exited on SIGTERM.
  }
}

/**
 * Spawns an agent process so that aborting `signal` kills the agent and every process it started (PRD §7.7), and so
 * that whatever it left running (a background `npm test`, an app the live tester booted) is killed once it exits: a
 * leftover process would keep files in the worktree open, and on Windows locked.
 * Agents run until they exit or are aborted; nothing stops them on a clock.
 * On POSIX the agent gets its own process group, killed as a whole. On Windows the agent runs inside a job object
 * (`windows-job.ts`); `detached` is left off there, as it would give every console program the agent starts its own
 * window.
 * `PWD` is set to the worktree: a child otherwise inherits ours (the repo root), and some CLIs (opencode) take their
 * working directory from `PWD` rather than the real cwd, so they would edit and commit in the user's checkout.
 * The run's own variables (`RUN_ENV_UNSET`) are not passed on.
 */
export function spawnAgent(file: string, args: string[], opts: SpawnOptions): SpawnedAgent {
  const job = WINDOWS ? jobLaunch(file, args, opts.cwd) : undefined;
  const env: NodeJS.ProcessEnv = { ...RUN_ENV_UNSET, PWD: opts.cwd, ...job?.env };
  const child = execa(job?.file ?? file, job?.args ?? args, {
    cwd: opts.cwd,
    env,
    detached: !WINDOWS,
    reject: false,
    input: opts.input ?? "",
    all: true,
    // Output is only read line by line through `child.iterable()`, and every line goes to the agent's log file.
    // Buffered, execa would also keep it all in memory (stdout, stderr and again `all`, up to 100 MB each) for as long
    // as the agent runs: a long run's agents filled the heap, and one past `maxBuffer` was killed.
    buffer: false,
  });
  let killing: Promise<void> | undefined;
  const kill = (): void => {
    if (child.pid !== undefined) killing ??= killTree(child.pid);
  };
  if (opts.signal.aborted) kill();
  else opts.signal.addEventListener("abort", kill, { once: true });
  const exitCode = child.then(async (res) => {
    opts.signal.removeEventListener("abort", kill);
    await killing;
    // POSIX: the group again, for what the agent left running. Windows: the launcher's job already took it down.
    if (!WINDOWS && child.pid !== undefined) await killTree(child.pid);
    // No exit code and no signal: the process never started (e.g. ENOENT).
    if (res.failed && res.exitCode === undefined && res.signal === undefined) {
      throw new Error(`failed to start "${file}": ${res.originalMessage || res.shortMessage}`, { cause: res });
    }
    return res.exitCode ?? 1;
  });
  return { child, exitCode };
}
