/**
 * Claude Code adapter (PRD §6, §9).
 *
 * Every real adapter (claude, codex, opencode) follows the same three-part pattern:
 *
 * 1. **Args builder** (`claudeArgs`): one argv array for the CLI's headless, full-auto mode, plus
 *    `--model` when given and extra flags from an env var (`GRAPH_EXECUTION_<NAME>_ARGS`, space-split).
 *    The prompt is a single argv entry; nothing ever goes through a shell.
 * 2. **Line parser** (`parseClaudeLine`): maps one line of the CLI's output to the text of an `output`
 *    event, falling back to the raw line for anything it does not recognise.
 * 3. **Registry entry** in `index.ts`: `getProvider(name)` returns the adapter after checking that the
 *    CLI is on the PATH, so a missing CLI aborts the run at startup.
 *
 * The process is started through `spawnAgent` with the worktree as cwd and stdin closed; aborting the
 * signal kills it. No credentials are read or set: the CLI uses the user's existing login.
 */
import { spawnAgent } from "./spawn.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "./types.js";

export const CLAUDE_BIN = "claude";

/** Extra CLI flags appended to every invocation, space-separated. */
export const CLAUDE_ARGS_ENV = "GRAPH_EXECUTION_CLAUDE_ARGS";

export function claudeArgs(opts: Pick<AgentRunOptions, "prompt" | "model">, env = process.env): string[] {
  const args = ["-p", opts.prompt, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  const extra = env[CLAUDE_ARGS_ENV]?.split(/\s+/).filter(Boolean) ?? [];
  return [...args, ...extra];
}

/** The assistant's text for `assistant` stream-json messages, otherwise the raw line. */
export function parseClaudeLine(line: string): string {
  try {
    const msg = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      const text = (msg.message.content as { type?: unknown; text?: unknown }[])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      if (text) return `${text}\n`;
    }
  } catch {
    // Not JSON (e.g. stderr): pass it through.
  }
  return `${line}\n`;
}

export const claudeProvider: Provider = {
  name: "claude",
  run(opts: AgentRunOptions): AgentRun {
    const agent = spawnAgent(CLAUDE_BIN, claudeArgs(opts), opts);
    const done = agent.exitCode.then((exitCode) => ({ exitCode }));
    // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
    done.catch(() => {});
    async function* events(): AsyncIterable<AgentEvent> {
      try {
        for await (const line of agent.child.iterable({ from: "all" })) {
          if (line) yield { type: "output", text: parseClaudeLine(line) };
        }
      } catch {
        // Spawn failures surface through `done`.
      }
      yield { type: "exit", code: (await done).exitCode };
    }
    return { events: events(), done };
  },
};
