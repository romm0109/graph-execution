import { execa } from "execa";

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
}

type Failure = { command: string; exitCode: number | undefined; output: string };

/** Runs one command through a shell; its failure, or undefined when it succeeds. */
async function runOne(command: string, cwd: string, signal?: AbortSignal): Promise<Failure | undefined> {
  const result = await execa(command, { shell: true, cwd, reject: false, all: true, cancelSignal: signal });
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
      const failure = await runOne(command, cwd, signal);
      if (failure) return { ok: false, ...failure };
    }
    return { ok: true };
  }
  const failures = (await Promise.all(commands.map((c) => runOne(c, cwd, signal)))).filter((f) => f !== undefined);
  if (failures.length === 0) return { ok: true };
  if (failures.length === 1) return { ok: false, ...failures[0]! };
  return {
    ok: false,
    command: failures.map((f) => f.command).join(", "),
    exitCode: failures[0]!.exitCode,
    output: failures.map((f) => `$ ${f.command}  (exit code ${f.exitCode ?? "none"})\n${f.output.trimEnd()}`).join("\n\n"),
  };
}
