import { createHash } from "node:crypto";
import type { AgentEvent, AgentRun, Provider, ToolCall } from "../providers/types.js";

/** Longest repeating cycle of tool calls looked for: `a`, `a b`, `a b c`. */
const MAX_CYCLE = 3;
/** How much of a call's input a loop message shows. */
const PREVIEW = 100;
/** Input keys that only describe a call, and differ between otherwise identical calls (Claude Code, Qwen Code). */
const DESCRIPTIVE_KEYS = new Set(["description"]);

/** An agent repeated the same tool call, or the same short cycle of calls, and was stopped. */
export class LoopDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
}

/** Two calls are the same when their tool and input are, ignoring key order and descriptive keys. */
export function toolSignature(call: ToolCall): string {
  const input =
    call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)
      ? Object.fromEntries(Object.entries(call.input).filter(([k]) => !DESCRIPTIVE_KEYS.has(k)))
      : call.input;
  return createHash("sha1").update(call.name).update("\0").update(JSON.stringify(canonical(input)) ?? "").digest("hex");
}

/** `Bash {"command":"npm test"}`, shortened. */
export function toolPreview(call: ToolCall): string {
  const input = JSON.stringify(call.input) ?? "";
  const text = `${call.name} ${input}`;
  return text.length <= PREVIEW ? text : `${text.slice(0, PREVIEW - 1)}…`;
}

/**
 * Watches one agent's tool calls. `push` returns why the agent is looping once the last `repeats` calls are all the
 * same call, or the last `repeats` cycles of 2 or 3 calls are all the same cycle; otherwise undefined.
 */
export class LoopDetector {
  private readonly signatures: string[] = [];
  private readonly calls: ToolCall[] = [];

  constructor(private readonly repeats: number) {}

  push(call: ToolCall): string | undefined {
    this.signatures.push(toolSignature(call));
    this.calls.push(call);
    const keep = MAX_CYCLE * this.repeats;
    if (this.signatures.length > keep) {
      this.signatures.splice(0, this.signatures.length - keep);
      this.calls.splice(0, this.calls.length - keep);
    }
    for (let cycle = 1; cycle <= MAX_CYCLE; cycle++) {
      if (this.repeatsCycle(cycle)) {
        const block = this.calls.slice(-cycle).map(toolPreview);
        return cycle === 1
          ? `it made the same tool call ${this.repeats} times in a row: ${block[0]}`
          : `it repeated the same ${cycle} tool calls ${this.repeats} times in a row: ${block.join(", then ")}`;
      }
    }
    return undefined;
  }

  private repeatsCycle(cycle: number): boolean {
    const s = this.signatures;
    const span = cycle * this.repeats;
    if (s.length < span) return false;
    const block = s.slice(-cycle);
    // A cycle made of one repeated call is the cycle-1 case; reporting it as a longer cycle would only confuse.
    if (cycle > 1 && block.every((x) => x === block[0])) return false;
    for (let i = 1; i <= span; i++) if (s[s.length - i] !== block[cycle - 1 - ((i - 1) % cycle)]) return false;
    return true;
  }
}

/** `loopDetection` from the config: how many repeats count as a loop, or false to never stop an agent for one. */
export type LoopSettings = { repeats: number } | false;

/**
 * Wraps `provider` so an agent stuck in a loop of tool calls is stopped: its process is killed as on an abort, and its
 * `done` rejects with `LoopDetectedError`, which `withRetries` counts as a failed attempt of class `loop`. Only the
 * agent is stopped; the run's own signal is untouched. `onLoop` is told the agent's label and why it was stopped.
 */
export function watchLoops(
  provider: Provider,
  settings: LoopSettings,
  onLoop?: (label: string, why: string) => void,
): Provider {
  if (settings === false) return provider;
  return {
    name: provider.name,
    run(opts): AgentRun {
      const own = new AbortController();
      const relay = (): void => own.abort(opts.signal.reason);
      if (opts.signal.aborted) own.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", relay, { once: true });
      const agent = provider.run({ ...opts, signal: own.signal });
      const detector = new LoopDetector(settings.repeats);
      let loop: LoopDetectedError | undefined;

      async function* events(): AsyncGenerator<AgentEvent> {
        try {
          for await (const event of agent.events) {
            if (event.type === "tool" && !loop) {
              const why = detector.push(event);
              if (why) {
                loop = new LoopDetectedError(`the agent was stopped because ${why}`);
                onLoop?.(opts.label, why);
                own.abort(loop);
              }
            }
            yield event;
          }
        } finally {
          opts.signal.removeEventListener("abort", relay);
        }
      }
      const done = agent.done.then((result) => {
        if (loop) throw loop;
        return result;
      });
      done.catch(() => {});
      return { events: events(), done };
    },
  };
}
