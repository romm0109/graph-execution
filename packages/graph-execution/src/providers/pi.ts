/**
 * pi coding agent adapter (`@mariozechner/pi-coding-agent`), following the pattern documented in `claude.ts`.
 *
 * Runs `pi --mode json --no-session`: one JSON event per line (parsed in `pi-json.ts`), and no session file left
 * behind. With stdin not a TTY, pi reads it, trims it and runs one-shot on it as the prompt, so neither `-p` nor a
 * positional prompt is needed. pi never asks for tool approval, so no flag is needed to run it unattended (the
 * worktree is the only isolation, PRD §9). pi exits 0 when the model request fails in json mode; `runPiLike` turns a
 * failed last assistant message into exit code 1. No credentials are read or set: the CLI uses the user's existing login.
 */
import { splitArgs } from "./args.js";
import { runPiLike } from "./pi-json.js";
import type { AgentRun, AgentRunOptions, Provider } from "./types.js";

export const PI_BIN = "pi";

/** Extra CLI flags appended to every invocation, split with shell-style quoting (see `splitArgs`). */
export const PI_ARGS_ENV = "GRAPH_EXECUTION_PI_ARGS";

export function piArgs(opts: Pick<AgentRunOptions, "model">, env = process.env): string[] {
  const args = ["--mode", "json", "--no-session"];
  if (opts.model) args.push("--model", opts.model);
  const extra = splitArgs(env[PI_ARGS_ENV], PI_ARGS_ENV);
  return [...args, ...extra];
}

export const piProvider: Provider = {
  name: "pi",
  run(opts: AgentRunOptions): AgentRun {
    return runPiLike(PI_BIN, piArgs(opts), opts);
  },
};
