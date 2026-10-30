import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRun, Provider } from "../providers/types.js";
import { IdleTimeoutError, watchIdle } from "./idle.js";

/** A provider whose agent prints `lines` then goes silent until aborted. */
function silentProvider(lines: number): Provider {
  return {
    name: "stub",
    run(opts): AgentRun {
      const done = new Promise<{ exitCode: number }>((resolve) =>
        opts.signal.addEventListener("abort", () => resolve({ exitCode: 1 }), {
          once: true,
        }),
      );
      async function* events(): AsyncGenerator<AgentEvent> {
        for (let i = 0; i < lines; i++)
          yield { type: "output", text: `line ${i}\n` };
        await done;
      }
      return { events: events(), done };
    },
  };
}

const opts = () => ({
  role: "task" as const,
  prompt: "",
  cwd: ".",
  signal: new AbortController().signal,
  label: "t1",
});

describe("watchIdle", () => {
  afterEach(() => vi.useRealTimers());

  it("fails an agent that stays silent", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const agent = watchIdle(silentProvider(1), 2, (label, why) =>
      seen.push(`${label}: ${why}`),
    ).run(opts());
    const result = expect(agent.done).rejects.toBeInstanceOf(IdleTimeoutError);
    void (async () => {
      for await (const event of agent.events) void event;
    })();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    await result;
    expect(seen).toEqual(["t1: it produced no output for 2 minutes"]);
  });

  it("does nothing when disabled", () => {
    const provider = silentProvider(0);
    expect(watchIdle(provider, 0)).toBe(provider);
  });
});
