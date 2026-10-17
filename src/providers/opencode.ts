/**
 * OpenCode CLI adapter (PRD §6, §9), following the pattern documented in `claude.ts`.
 *
 * Runs `opencode run` unattended (`--auto`: auto-approves every permission that is not explicitly denied;
 * the worktree is the only isolation, PRD §9) with `--format json` so text parts can be picked out of the
 * JSONL stream. The prompt goes last, after `--`, so it is never parsed as a flag.
 * No credentials are read or set: the CLI uses the user's existing login.
 */
import { spawnAgent } from "./spawn.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "./types.js";

export const OPENCODE_BIN = "opencode";

/** Extra CLI flags appended to every invocation, space-separated. */
export const OPENCODE_ARGS_ENV = "GRAPH_EXECUTION_OPENCODE_ARGS";

export function opencodeArgs(opts: Pick<AgentRunOptions, "prompt" | "model">, env = process.env): string[] {
  const args = ["run", "--auto", "--format", "json"];
  if (opts.model) args.push("--model", opts.model);
  const extra = env[OPENCODE_ARGS_ENV]?.split(/\s+/).filter(Boolean) ?? [];
  return [...args, ...extra, "--", opts.prompt];
}

/** The text of `text` events, otherwise the raw line. */
export function parseOpencodeLine(line: string): string {
  try {
    const msg = JSON.parse(line) as { type?: unknown; part?: { type?: unknown; text?: unknown } };
    if (msg.type === "text" && msg.part?.type === "text" && typeof msg.part.text === "string") {
      if (msg.part.text) return `${msg.part.text}\n`;
    }
  } catch {
    // Not JSON (e.g. stderr): pass it through.
  }
  return `${line}\n`;
}

export const opencodeProvider: Provider = {
  name: "opencode",
  run(opts: AgentRunOptions): AgentRun {
    const agent = spawnAgent(OPENCODE_BIN, opencodeArgs(opts), opts);
    const done = agent.exitCode.then((exitCode) => ({ exitCode }));
    // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
    done.catch(() => {});
    async function* events(): AsyncIterable<AgentEvent> {
      try {
        for await (const line of agent.child.iterable({ from: "all" })) {
          if (line) yield { type: "output", text: parseOpencodeLine(line) };
        }
      } catch {
        // Spawn failures surface through `done`.
      }
      yield { type: "exit", code: (await done).exitCode };
    }
    return { events: events(), done };
  },
};
