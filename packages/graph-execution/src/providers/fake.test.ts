import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { createFakeProvider, FAKE_PROMPTS_ENV, fakeScriptSchema } from "./fake.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it("writes every prompt to <dir>/<role>-<label>.md when GRAPH_EXECUTION_FAKE_PROMPTS is set", async () => {
    const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "fake-prompts-")), "nested");
    process.env[FAKE_PROMPTS_ENV] = dir;
    try {
      const { done } = createFakeProvider().run({ ...opts("code-r0"), role: "reviewer", prompt: "review it" });
      expect(await readFile(path.join(dir, "reviewer-code-r0.md"), "utf8")).toBe("review it");
      await done;
    } finally {
      delete process.env[FAKE_PROMPTS_ENV];
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("writes an escalate attempt to the escalation file and exits 0 without committing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fake-escalate-"));
    try {
      const file = path.join(dir, "inbox", "2-a1.json");
      const escalation = { reason: "r", evidence: "e", questions: [{ id: "q1", question: "A or B?" }] };
      const provider = createFakeProvider(fakeScriptSchema.parse({ "task:2": { attempts: [{ escalate: escalation }, { escalate: "invalid" }, { escalate: escalation }] } }));
      const first = provider.run({ ...opts("2"), escalationFile: file });
      expect(await collect(first.events)).toEqual([
        { type: "output", text: "escalated\n" },
        { type: "exit", code: 0 },
      ]);
      expect(await first.done).toEqual({ exitCode: 0 });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(escalation);
      expect(await gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("1");

      await provider.run({ ...opts("2"), escalationFile: file }).done;
      expect(await readFile(file, "utf8")).toBe("{}");

      // Without an escalation file the attempt runs as a plain one.
      await provider.run(opts("2")).done;
      expect(await gitOut(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
