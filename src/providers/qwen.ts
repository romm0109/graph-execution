/**
 * Qwen Code CLI adapter (PRD §6, §9), following the pattern documented in `claude.ts`.
 *
 * Runs `qwen` unattended (`--yolo`: auto-approves every tool; the worktree is the only isolation, PRD §9) with
 * `--output-format stream-json`, whose messages have the same shape as Claude Code's. With no positional prompt and
 * stdin not a TTY, `qwen` runs one-shot on the prompt sent to stdin (`-p` is deprecated and would put it on argv).
 * No credentials are read or set: the CLI uses the user's existing login.
 */
import { spawnAgent } from "./spawn.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "./types.js";

export const QWEN_BIN = "qwen";

/** Extra CLI flags appended to every invocation, space-separated. */
export const QWEN_ARGS_ENV = "GRAPH_EXECUTION_QWEN_ARGS";

export function qwenArgs(opts: Pick<AgentRunOptions, "model">, env = process.env): string[] {
  const args = ["--yolo", "--output-format", "stream-json"];
  if (opts.model) args.push("--model", opts.model);
  const extra = env[QWEN_ARGS_ENV]?.split(/\s+/).filter(Boolean) ?? [];
  return [...args, ...extra];
}

/** The assistant's text for `assistant` stream-json messages, otherwise the raw line. */
export function parseQwenLine(line: string): string {
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

export const qwenProvider: Provider = {
  name: "qwen",
  run(opts: AgentRunOptions): AgentRun {
    const agent = spawnAgent(QWEN_BIN, qwenArgs(opts), { ...opts, input: opts.prompt });
    const done = agent.exitCode.then((exitCode) => ({ exitCode }));
    // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
    done.catch(() => {});
    async function* events(): AsyncIterable<AgentEvent> {
      try {
        for await (const line of agent.child.iterable({ from: "all" })) {
          if (line) yield { type: "output", text: parseQwenLine(line) };
        }
      } catch {
        // Spawn failures surface through `done`.
      }
      yield { type: "exit", code: (await done).exitCode };
    }
    return { events: events(), done };
  },
};
