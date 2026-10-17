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

/**
 * Runs user commands one after another in `cwd`, stopping at the first failure (no AI). Commands come from the
 * user's config or task files, so they deliberately go through a shell.
 */
export async function runCommands(commands: readonly string[], cwd: string, signal?: AbortSignal): Promise<CommandsResult> {
  for (const command of commands) {
    const result = await execa(command, { shell: true, cwd, reject: false, all: true, cancelSignal: signal });
    if (result.exitCode !== 0 || result.failed) {
      const output = result.all || result.message || "";
      return { ok: false, command, exitCode: result.exitCode, output: truncateOutput(output) };
    }
  }
  return { ok: true };
}
