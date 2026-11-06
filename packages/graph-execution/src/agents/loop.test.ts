import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider, ToolCall } from "../providers/types.js";
import { LoopDetectedError, LoopDetector, toolSignature, watchLoops } from "./loop.js";

const bash = (command: string, description?: string): ToolCall => ({
  name: "Bash",
  input: description === undefined ? { command } : { command, description },
});
const read = (path: string): ToolCall => ({ name: "Read", input: { file_path: path } });

/** Pushes `calls` in order and returns what the last push said. */
const feed = (detector: LoopDetector, calls: ToolCall[]): string | undefined => {
  let out: string | undefined;
  for (const call of calls) out = detector.push(call);
  return out;
};

describe("toolSignature", () => {
  it("ignores the description and the key order", () => {
    expect(toolSignature(bash("npm test", "first"))).toBe(toolSignature(bash("npm test", "second")));
    expect(toolSignature({ name: "Edit", input: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      toolSignature({ name: "Edit", input: { b: { d: 3, c: 2 }, a: 1 } }),
    );
  });
  it("tells different tools and inputs apart", () => {
    expect(toolSignature(bash("npm test"))).not.toBe(toolSignature(bash("npm run lint")));
    expect(toolSignature({ name: "Bash", input: {} })).not.toBe(toolSignature({ name: "Read", input: {} }));
  });
});

describe("LoopDetector", () => {
  it("reports the same call repeated `repeats` times in a row, not before", () => {
    const d = new LoopDetector(5);
    expect(feed(d, Array.from({ length: 4 }, (_, i) => bash("npm test", `run ${i}`)))).toBeUndefined();
    expect(d.push(bash("npm test", "run 5"))).toBe(
      'it made the same tool call 5 times in a row: Bash {"command":"npm test","description":"run 5"}',
    );
  });
  it("does not report repeats broken by another call", () => {
    const calls = [bash("npm test"), bash("npm test"), bash("npm test"), read("a.ts"), bash("npm test"), bash("npm test")];
    expect(feed(new LoopDetector(5), calls)).toBeUndefined();
  });
  it("does not report a run of different calls", () => {
    expect(feed(new LoopDetector(3), [read("a"), read("b"), read("c"), read("d"), read("e"), read("f")])).toBeUndefined();
  });
  it("reports a cycle of two calls repeated `repeats` times", () => {
    const cycle = [read("a.ts"), bash("npm test")];
    const d = new LoopDetector(3);
    expect(feed(d, [...cycle, ...cycle])).toBeUndefined();
    expect(feed(d, cycle)).toBe(
      'it repeated the same 2 tool calls 3 times in a row: Read {"file_path":"a.ts"}, then Bash {"command":"npm test"}',
    );
  });
  it("reports a cycle of three calls", () => {
    const cycle = [read("a.ts"), { name: "Edit", input: { old: "x", new: "y" } }, bash("npm test")];
    expect(feed(new LoopDetector(2), [...cycle, ...cycle])).toMatch(/^it repeated the same 3 tool calls 2 times/);
  });
  it("shortens a long input in the message", () => {
    const d = new LoopDetector(2);
    const message = feed(d, [bash("x".repeat(500)), bash("x".repeat(500))])!;
    expect(message.length).toBeLessThan(200);
    expect(message.endsWith("…")).toBe(true);
  });
});

/** A provider whose agent emits `tools`, then runs until its signal is aborted (or exits 0 at once if `finish`). */
function scripted(tools: ToolCall[], finish = false) {
  const seen: AgentRunOptions[] = [];
  const provider: Provider = {
    name: "scripted",
    run(opts): AgentRun {
      seen.push(opts);
      const done = finish
        ? Promise.resolve({ exitCode: 0 })
        : new Promise<{ exitCode: number }>((resolve) =>
            opts.signal.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true }),
          );
      async function* events(): AsyncGenerator<AgentEvent> {
        for (const call of tools) yield { type: "tool", ...call };
        yield { type: "exit", code: (await done).exitCode };
      }
      return { events: events(), done };
    },
  };
  return { provider, seen };
}

const runOpts = (signal: AbortSignal): AgentRunOptions => ({ role: "task", prompt: "p", cwd: "/w", signal, label: "3" });

async function drain(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) out.push(event);
  return out;
}

describe("watchLoops", () => {
  it("stops a looping agent and rejects its done with LoopDetectedError, leaving the run's signal alone", async () => {
    const { provider, seen } = scripted(Array.from({ length: 8 }, (_, i) => bash("npm test", `run ${i}`)));
    const loops: string[] = [];
    const run = new AbortController();
    const agent = watchLoops(provider, { repeats: 5 }, (label, why) => loops.push(`${label}: ${why}`)).run(
      runOpts(run.signal),
    );
    await drain(agent);
    await expect(agent.done).rejects.toBeInstanceOf(LoopDetectedError);
    await expect(agent.done).rejects.toThrow(/^the agent was stopped because it made the same tool call 5 times/);
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatch(/^3: it made the same tool call 5 times/);
  });

  it("passes an agent that does not loop through unchanged", async () => {
    const { provider } = scripted([bash("npm test"), read("a.ts"), bash("npm test")], true);
    const agent = watchLoops(provider, { repeats: 2 }).run(runOpts(new AbortController().signal));
    expect((await drain(agent)).filter((e) => e.type === "tool")).toHaveLength(3);
    await expect(agent.done).resolves.toEqual({ exitCode: 0 });
  });

  it("still stops the agent when the run is aborted", async () => {
    const { provider, seen } = scripted([]);
    const run = new AbortController();
    const agent = watchLoops(provider, { repeats: 5 }).run(runOpts(run.signal));
    run.abort();
    await expect(agent.done).resolves.toEqual({ exitCode: 130 });
    expect(seen[0]!.signal.aborted).toBe(true);
  });

  it("returns the provider itself when loop detection is off", () => {
    const { provider } = scripted([]);
    expect(watchLoops(provider, false)).toBe(provider);
  });
});
