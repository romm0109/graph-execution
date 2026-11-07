import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { killTree, WINDOWS } from "../providers/spawn.js";
import { RUN_ENV_UNSET } from "../state/paths.js";
import { posixShell } from "./shell.js";

export const MAX_OUTPUT_LINES = 200;
export const MAX_OUTPUT_BYTES = 8 * 1024;

export type CommandsResult = { ok: true } | { ok: false; command: string; exitCode: number | undefined; output: string };

/** Keeps the relevant tail of a command's output: the last 200 lines, at most 8 KB (PRD §7.4). */
export function truncateOutput(output: string): string {
  const lines = output.split("\n");
  let tail = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES).join("\n") : output;
  const bytes = Buffer.from(tail, "utf8");
  if (bytes.length > MAX_OUTPUT_BYTES) {
    // Drop the partial first line so the tail starts cleanly.
    tail = bytes.subarray(-MAX_OUTPUT_BYTES).toString("utf8");
    tail = tail.slice(tail.indexOf("\n") + 1);
  }
  return tail === output ? output : `[output truncated]\n${tail}`;
}

export interface RunCommandsOptions {
  /**
   * Starts every command at once and lets each one finish, so a failure reports all failing commands together
   * (`config.validateParallel`). Sequential by default, stopping at the first failure.
   */
  parallel?: boolean;
  /** The `sh` that runs each command as `sh -c <command>`; `posixShell()` by default. */
  shell?: string;
}

type Failure = { command: string; exitCode: number | undefined; output: string };

/**
 * Runs one command through a shell (`sh`, also on Windows when one is found: see `posixShell`); its failure, or undefined when it succeeds. Aborting `signal` kills the command
 * and every process it started: on POSIX the shell leads its own process group, signalled as a whole; on Windows
 * `taskkill /T` walks the tree. execa's own `cancelSignal` would kill only the shell, leaving the real command running
 * (and holding the output pipe open, so the promise would not settle). A command that exits on its own is not
 * followed by a group kill: a setup command may deliberately leave a background process behind.
 */
async function runOne(command: string, cwd: string, signal?: AbortSignal, sh = posixShell()): Promise<Failure | undefined> {
  // Nothing is started once the signal has aborted: killing right after the spawn races the shell starting its
  // command, and on Windows `taskkill /T` can run before the command exists and miss it.
  if (signal?.aborted) return { command, exitCode: undefined, output: "not started: interrupted" };
  const options = { cwd, env: RUN_ENV_UNSET, reject: false, all: true, detached: !WINDOWS } as const;
  const child = sh ? execa(sh, ["-c", command], options) : execa(command, { ...options, shell: true });
  let killing: Promise<void> | undefined;
  const kill = (): void => {
    if (child.pid !== undefined) killing ??= killTree(child.pid);
  };
  if (signal?.aborted) kill();
  else signal?.addEventListener("abort", kill, { once: true });
  let result;
  try {
    result = await child;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
  await killing;
  if (result.exitCode === 0 && !result.failed) return undefined;
  return { command, exitCode: result.exitCode, output: truncateOutput(result.all || result.message || "") };
}

/**
 * Runs user commands in `cwd` (no AI): one after another, stopping at the first failure, or all at once with
 * `parallel`. Commands come from the user's config or task files, so they deliberately go through a shell.
 * Several parallel failures come back as one: the commands joined, each one's output under a `$ command` header.
 */
export async function runCommands(
  commands: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  opts: RunCommandsOptions = {},
): Promise<CommandsResult> {
  if (!opts.parallel) {
    for (const command of commands) {
      const failure = await runOne(command, cwd, signal, opts.shell);
      if (failure) return { ok: false, ...failure };
    }
    return { ok: true };
  }
  const failures = (await Promise.all(commands.map((c) => runOne(c, cwd, signal, opts.shell)))).filter((f) => f !== undefined);
  if (failures.length === 0) return { ok: true };
  if (failures.length === 1) return { ok: false, ...failures[0]! };
  return {
    ok: false,
    command: failures.map((f) => f.command).join(", "),
    exitCode: failures[0]!.exitCode,
    output: failures.map((f) => `$ ${f.command}  (exit code ${f.exitCode ?? "none"})\n${f.output.trimEnd()}`).join("\n\n"),
  };
}

/** A failed run of the validation commands, as `runCommands` reports it. */
export type CommandsFailure = Extract<CommandsResult, { ok: false }>;

/**
 * Writes a failed validation's output, the same tail the agent gets, to `<logsDir>/<name>.log`, and returns a short
 * description for the run's log: the failing command(s) and where the output is.
 */
export async function writeValidationLog(logsDir: string, name: string, failure: CommandsFailure): Promise<string> {
  await mkdir(logsDir, { recursive: true });
  const file = path.join(logsDir, `${name}.log`);
  const header = `$ ${failure.command}\n(exit code ${failure.exitCode ?? "none"})\n\n`;
  await writeFile(file, `${header}${failure.output.trimEnd()}\n`);
  return `\`${failure.command}\` failed (exit code ${failure.exitCode ?? "none"}); output in ${path.join(path.basename(logsDir), path.basename(file))}`;
}
