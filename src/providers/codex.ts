/**
 * Codex CLI adapter (PRD §6, §9), following the pattern documented in `claude.ts`.
 *
 * Runs `codex exec` unattended (`--dangerously-bypass-approvals-and-sandbox`: no approval prompts; the
 * worktree is the only isolation, PRD §9) with `--json` so agent messages can be picked out of the JSONL
 * stream. The prompt goes last, after `--`, so it is never parsed as a flag or an `exec` subcommand.
 * No credentials are read or set: the CLI uses the user's existing login.
 */
import { spawnAgent } from "./spawn.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "./types.js";

export const CODEX_BIN = "codex";

/** Extra CLI flags appended to every invocation, space-separated. */
export const CODEX_ARGS_ENV = "GRAPH_EXECUTION_CODEX_ARGS";

export function codexArgs(opts: Pick<AgentRunOptions, "prompt" | "model">, env = process.env): string[] {
  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json"];
  if (opts.model) args.push("--model", opts.model);
  const extra = env[CODEX_ARGS_ENV]?.split(/\s+/).filter(Boolean) ?? [];
  return [...args, ...extra, "--", opts.prompt];
}

/** The text of completed `agent_message` items, otherwise the raw line. */
export function parseCodexLine(line: string): string {
  try {
    const msg = JSON.parse(line) as {
      type?: unknown;
      item?: { type?: unknown; text?: unknown };
    };
    if (msg.type === "item.completed" && msg.item?.type === "agent_message" && typeof msg.item.text === "string") {
      if (msg.item.text) return `${msg.item.text}\n`;
    }
  } catch {
    // Not JSON (e.g. stderr): pass it through.
  }
  return `${line}\n`;
}

export const codexProvider: Provider = {
  name: "codex",
  run(opts: AgentRunOptions): AgentRun {
    const agent = spawnAgent(CODEX_BIN, codexArgs(opts), opts);
    const done = agent.exitCode.then((exitCode) => ({ exitCode }));
    // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
    done.catch(() => {});
    async function* events(): AsyncIterable<AgentEvent> {
      try {
        for await (const line of agent.child.iterable({ from: "all" })) {
          if (line) yield { type: "output", text: parseCodexLine(line) };
        }
      } catch {
        // Spawn failures surface through `done`.
      }
      yield { type: "exit", code: (await done).exitCode };
    }
    return { events: events(), done };
  },
};
