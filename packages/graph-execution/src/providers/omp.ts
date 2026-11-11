/**
 * oh-my-pi adapter (`@oh-my-pi/pi-coding-agent`, a fork of pi), following the pattern documented in `claude.ts`.
 *
 * Runs `omp --mode json --no-session --auto-approve`, with the same JSON events as pi (parsed in `pi-json.ts`) and the
 * prompt on stdin. `--auto-approve` is always passed: a user's `approvalMode` setting would otherwise deny tools in
 * headless mode and still exit 0 (the worktree is the only isolation, PRD §9). omp runs only on Bun, so `getProvider`
 * checks for `bun` too. omp exits 1 when the model request fails, but the failed last assistant message is checked
 * as for pi anyway. No credentials are read or set: the CLI uses the user's existing login.
 */
import { splitArgs } from "./args.js";
import { runPiLike } from "./pi-json.js";
import type { AgentRun, AgentRunOptions, Provider } from "./types.js";

export const OMP_BIN = "omp";

/** The runtime omp needs (its bin starts with `#!/usr/bin/env bun`). */
export const OMP_RUNTIME_BIN = "bun";

/** Extra CLI flags appended to every invocation, split with shell-style quoting (see `splitArgs`). */
export const OMP_ARGS_ENV = "GRAPH_EXECUTION_OMP_ARGS";

export function ompArgs(opts: Pick<AgentRunOptions, "model">, env = process.env): string[] {
  const args = ["--mode", "json", "--no-session", "--auto-approve"];
  if (opts.model) args.push("--model", opts.model);
  const extra = splitArgs(env[OMP_ARGS_ENV], OMP_ARGS_ENV);
  return [...args, ...extra];
}

export const ompProvider: Provider = {
  name: "omp",
  run(opts: AgentRunOptions): AgentRun {
    return runPiLike(OMP_BIN, ompArgs(opts), opts);
  },
};
