import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { createFakeProvider, fakeScriptSchema } from "./fake.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const opts = (label: string): AgentRunOptions => ({
  role: "task",
  prompt: "do it",
  cwd: repo,
  signal: new AbortController().signal,
  label,
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("fake provider", () => {
  it("writes <id>.txt and commits when the task has no script entry", async () => {
    const provider = createFakeProvider();
    const { events, done } = provider.run(opts("7"));
    expect(await collect(events)).toEqual([
      { type: "output", text: "wrote 7.txt\n" },
      { type: "exit", code: 0 },
    ]);
    expect(await done).toEqual({ exitCode: 0 });
    expect(await readFile(path.join(repo, "7.txt"), "utf8")).toBe("7\n");
    expect(await gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(provider.calls.map((c) => c.prompt)).toEqual(["do it"]);
  });

  it("consumes scripted attempts in order per key and ignores unknown keys", async () => {
    const script = fakeScriptSchema.parse({
      "task:1": {
        future: true,
        attempts: [
          { write: { "a/b.txt": "x" }, commit: false, exitCode: 3, later: "ignored" },
          { write: { "c.txt": "y" } },
        ],
      },
    });
    const provider = createFakeProvider(script);

    const first = provider.run(opts("1"));
    expect(await collect(first.events)).toEqual([
      { type: "output", text: "wrote a/b.txt\n" },
      { type: "exit", code: 3 },
    ]);
    expect(await first.done).toEqual({ exitCode: 3 });
    expect(await gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("1");

    const second = provider.run(opts("1"));
    expect(await second.done).toEqual({ exitCode: 0 });
    expect(await gitOut(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("a/b.txt\nc.txt");
  });
});
