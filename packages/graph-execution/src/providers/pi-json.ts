/**
 * The JSON event stream shared by pi (`@mariozechner/pi-coding-agent`) and its fork oh-my-pi (`omp`), both run with
 * `--mode json`: one JSON object per line (`session`, `agent_*`, `turn_*`, `message_start`, `message_update`,
 * `message_end`, `tool_execution_*`). The assistant's text is taken from each assistant `message_end`; the streamed
 * deltas and the tool events are dropped from the output (tool calls are reported as `tool` events instead, see
 * `piJsonToolCalls`). Unknown JSON event types are dropped too; a line that is not JSON (stderr) is kept as is.
 *
 * pi exits 0 in `--mode json` even when the model request failed. The last assistant `message_end` tells: its
 * `stopReason` is `"error"` or `"aborted"` and `errorMessage` holds the reason. `runPiLike` turns that into exit code 1.
 */
import { spawnAgent } from "./spawn.js";
import { piJsonToolCalls } from "./tools.js";
import type { AgentEvent, AgentRun, AgentRunOptions } from "./types.js";

interface PiMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The message of an assistant `message_end` event, or undefined for any other line. */
function assistantEnd(event: Record<string, unknown> | undefined): PiMessage | undefined {
  if (event?.type !== "message_end") return undefined;
  const message = event.message as PiMessage | undefined;
  return typeof message === "object" && message !== null && message.role === "assistant" ? message : undefined;
}

/**
 * The text of an `output` event for one line: the joined text items of an assistant `message_end` plus a newline,
 * `""` (skipped by the caller) for every other JSON event, and the raw line plus a newline for anything not JSON.
 */
export function parsePiLine(line: string): string {
  const event = parse(line);
  if (event === undefined) return `${line}\n`;
  const message = assistantEnd(event);
  if (message === undefined || !Array.isArray(message.content)) return "";
  const text = (message.content as { type?: unknown; text?: unknown }[])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
  return text ? `${text}\n` : "";
}

/**
 * For an assistant `message_end` whose `stopReason` is `"error"` or `"aborted"`: its `errorMessage` (or a generic
 * reason). Undefined for any other line, including an assistant `message_end` that did not fail.
 */
export function piFailure(line: string): string | undefined {
  const message = assistantEnd(parse(line));
  if (message?.stopReason !== "error" && message?.stopReason !== "aborted") return undefined;
  return typeof message.errorMessage === "string" && message.errorMessage !== "" ? message.errorMessage : "the model request failed";
}

/** Whether `line` is an assistant `message_end` (whose stopReason replaces the one remembered before). */
function isAssistantEnd(line: string): boolean {
  return assistantEnd(parse(line)) !== undefined;
}

/**
 * Runs a pi-like CLI (`bin args`, prompt on stdin) as an `AgentRun`. The output is read in the background from the
 * start, so `done` can wait for both the exit code and the last line: when the last assistant message failed and the
 * process still exited 0, `done` resolves to exit code 1, and an output event `<bin>: <reason>` says why.
 */
export function runPiLike(bin: string, args: string[], opts: AgentRunOptions): AgentRun {
  const agent = spawnAgent(bin, args, { ...opts, input: opts.prompt });
  const queue: AgentEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  const push = (event: AgentEvent): void => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  // Resolves with the failure reason of the last assistant message, or undefined. Never rejects.
  const read = (async (): Promise<string | undefined> => {
    let failure: string | undefined;
    try {
      for await (const line of agent.child.iterable({ from: "all" })) {
        if (!line) continue;
        if (isAssistantEnd(line)) failure = piFailure(line);
        const text = parsePiLine(line);
        if (text) push({ type: "output", text });
        for (const call of piJsonToolCalls(line)) push({ type: "tool", ...call });
      }
    } catch {
      // Spawn failures surface through `done`.
    }
    if (failure !== undefined) push({ type: "output", text: `${bin}: ${failure}\n` });
    finished = true;
    wake?.();
    wake = undefined;
    return failure;
  })();
  const done = Promise.all([agent.exitCode, read]).then(([exitCode, failure]) => ({
    exitCode: exitCode === 0 && failure !== undefined ? 1 : exitCode,
  }));
  // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
  done.catch(() => {});
  async function* events(): AsyncIterable<AgentEvent> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    yield { type: "exit", code: (await done).exitCode };
  }
  return { events: events(), done };
}
