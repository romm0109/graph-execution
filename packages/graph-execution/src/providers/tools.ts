/**
 * Tool calls picked out of each agent CLI's JSON output, for loop detection. Every CLI reports them differently:
 *
 * - Claude Code and Qwen Code (`stream-json`): `tool_use` blocks in `assistant` messages, `{ name, input }`.
 * - Codex (`exec --json`): `item.started` then `item.completed` per call; only the completed one is counted.
 * - OpenCode (`run --format json`): one `tool_use` event per finished call, `{ part: { tool, state: { input } } }`.
 * - pi and oh-my-pi (`--mode json`): one `tool_execution_start` event per call, `{ toolName, args }`. The call also
 *   appears in the assistant's `message_end` and again in `tool_execution_end`; only the start is counted.
 * - GitHub Copilot (`--output-format json`): one `tool.execution_start` event per call,
 *   `{ data: { toolName, arguments } }`. The call also appears in the `assistant.message`'s `toolRequests` and in
 *   `tool.execution_complete`; only the start is counted.
 *
 * A line that is not JSON, or not a tool call, gives no calls.
 */
import type { ToolCall } from "./types.js";

function json(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code and Qwen Code: the `tool_use` blocks of an `assistant` message. */
export function streamJsonToolCalls(line: string): ToolCall[] {
  const msg = json(line);
  if (msg?.type !== "assistant") return [];
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; name: string; input?: unknown } => b?.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({ name: b.name, input: b.input ?? {} }));
}

/** Codex items that are not tool calls. */
const CODEX_NOT_TOOLS = new Set(["agent_message", "reasoning", "error", "todo_list"]);
/** Codex item fields that change between identical calls. */
const CODEX_VOLATILE = new Set(["id", "type", "status", "aggregated_output", "exit_code", "output", "result", "error"]);

/** Codex: a completed item other than a message, e.g. `command_execution` with its `command`. */
export function codexToolCalls(line: string): ToolCall[] {
  const msg = json(line);
  if (msg?.type !== "item.completed") return [];
  const item = msg.item as Record<string, unknown> | undefined;
  if (!item || typeof item.type !== "string" || CODEX_NOT_TOOLS.has(item.type)) return [];
  const input = Object.fromEntries(Object.entries(item).filter(([k]) => !CODEX_VOLATILE.has(k)));
  return [{ name: item.type, input }];
}

/** OpenCode: a `tool_use` event, e.g. `shell` with `{ command }`. */
export function opencodeToolCalls(line: string): ToolCall[] {
  const msg = json(line);
  if (msg?.type !== "tool_use") return [];
  const part = msg.part as { tool?: unknown; state?: { input?: unknown } } | undefined;
  if (typeof part?.tool !== "string") return [];
  return [{ name: part.tool, input: part.state?.input ?? {} }];
}

/** pi and oh-my-pi: a `tool_execution_start` event, e.g. `bash` with `{ command }`. */
export function piJsonToolCalls(line: string): ToolCall[] {
  const msg = json(line);
  if (msg?.type !== "tool_execution_start" || typeof msg.toolName !== "string") return [];
  return [{ name: msg.toolName, input: msg.args ?? {} }];
}

/** GitHub Copilot: a `tool.execution_start` event, e.g. `bash` with `{ command }`. */
export function copilotToolCalls(line: string): ToolCall[] {
  const msg = json(line);
  if (msg?.type !== "tool.execution_start") return [];
  const data = msg.data as { toolName?: unknown; arguments?: unknown } | undefined;
  if (typeof data?.toolName !== "string") return [];
  return [{ name: data.toolName, input: data.arguments ?? {} }];
}
