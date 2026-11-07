import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "../providers/types.js";
import { IdleTimeoutError, watchIdle } from "./idle.js";

/** A provider whose agent prints `lines` lines, one every `everyMs` (0: at once), then stays silent until aborted. */
function silentProvider(lines: number, everyMs = 0): Provider {
  return {
    name: "stub",
    run(opts): AgentRun {
      const done = new Promise<{ exitCode: number }>((resolve) =>
        opts.signal.addEventListener("abort", () => resolve({ exitCode: 1 }), { once: true }),
      );
      async function* events(): AsyncGenerator<AgentEvent> {
        for (let i = 0; i < lines; i++) {
          if (everyMs > 0) await new Promise((r) => setTimeout(r, everyMs));
          yield { type: "output", text: `line ${i}\n` };
        }
        await done;
      }
      return { events: events(), done };
    },
  };
}

const opts = (signal = new AbortController().signal, cwd = "."): AgentRunOptions => ({
  role: "task",
  prompt: "",
  cwd,
  signal,
  label: "t1",
});

const drain = (agent: AgentRun): void => {
  void (async () => {
    for await (const event of agent.events) void event;
  })();
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("watchIdle", () => {
  let dir: string | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("fails an agent that stays silent", async () => {
    vi.useFakeTimers();
    const seen: [string, string][] = [];
    const agent = watchIdle(silentProvider(1), 2, (label, why) => seen.push([label, why])).run(opts());
    const result = expect(agent.done).rejects.toBeInstanceOf(IdleTimeoutError);
    drain(agent);
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    await result;
    expect(seen).toEqual([["t1", "it produced no output for 2 minutes"]]);
  });

  it("re-arms the timer on every event", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const outer = new AbortController();
    const agent = watchIdle(silentProvider(5, 60_000), 2, onIdle).run(opts(outer.signal));
    drain(agent);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(onIdle).not.toHaveBeenCalled();
    outer.abort();
    await expect(agent.done).resolves.toEqual({ exitCode: 1 });
  });

  it("does nothing when disabled", () => {
    const provider = silentProvider(0);
    expect(watchIdle(provider, 0)).toBe(provider);
  });

  it("does not turn the run's own abort into an idle error", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const outer = new AbortController();
    const agent = watchIdle(silentProvider(1), 2, onIdle).run(opts(outer.signal));
    drain(agent);
    await vi.advanceTimersByTimeAsync(60_000);
    outer.abort();
    await expect(agent.done).resolves.toEqual({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("kills a hung agent process", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "graph-execution-idle-"));
    const provider = createFakeProvider(fakeScriptSchema.parse({ "task:1": { attempts: [{ hang: true }] } }));
    const agent = watchIdle(provider, 0.005).run({ ...opts(new AbortController().signal, dir), label: "1" });
    drain(agent);
    await expect(agent.done).rejects.toBeInstanceOf(IdleTimeoutError);
    const pid = provider.pids[0]!;
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 10_000);
});
