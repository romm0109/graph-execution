import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { planContentPathLine, planRefsPathLine, planResultPathLine } from "../plan/prompt.js";
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

  describe("planner", () => {
    async function plan(content: string, refs?: string[]): Promise<unknown> {
      const dir = await mkdtemp(path.join(os.tmpdir(), "fake-plan-"));
      try {
        const contentFile = path.join(dir, "content.md");
        const resultFile = path.join(dir, "result.json");
        await writeFile(contentFile, content);
        const lines = [planContentPathLine(contentFile)];
        if (refs) {
          const refsFile = path.join(dir, "refs.json");
          await writeFile(refsFile, JSON.stringify(refs.map((ref) => ({ ref }))));
          lines.push(planRefsPathLine(refsFile));
        }
        lines.push(planResultPathLine(resultFile));
        const { events, done } = createFakeProvider().run({ ...opts("plan"), role: "planner", prompt: lines.join("\n") });
        await collect(events);
        await done;
        return JSON.parse(await readFile(resultFile, "utf8"));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it("plans the content as one ready unit by default", async () => {
      expect(await plan("# Build\n")).toEqual({ name: "fake-plan", ready: true, questions: [] });
      expect(existsSync(path.join(repo, ".agents", "tasks", "fake-plan", "1.json"))).toBe(true);
    });

    it("marks the content not ready with a NOT-READY line and writes no files", async () => {
      expect(await plan("# Build\n  NOT-READY  \n")).toEqual({ ready: false, questions: ["What should be built?"] });
      expect(existsSync(path.join(repo, "docs", "prd", "fake-plan.md"))).toBe(false);
    });

    it("drops the refs marked NOT-READY: <ref>", async () => {
      expect(await plan("# Build\nNOT-READY: B\n", ["A", "B"])).toEqual({
        name: "fake-plan",
        ready: ["A"],
        notReady: [{ ref: "B", questions: ["What is missing for B?"] }],
      });
    });

    it("hangs until the signal stops it with a hang attempt, writing nothing", async () => {
      const controller = new AbortController();
      const provider = createFakeProvider({ "planner:plan": { attempts: [{ hang: true }] } } as never);
      const { events, done } = provider.run({ ...opts("plan"), role: "planner", prompt: "", signal: controller.signal });
      const all = collect(events);
      for (let i = 0; i < 100 && provider.pids.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(provider.pids).toHaveLength(1);
      controller.abort();
      await all;
      await done.catch(() => undefined);
      expect(existsSync(path.join(repo, "docs", "prd", "fake-plan.md"))).toBe(false);
    });

    it("writes no name and no files when no ref is ready", async () => {
      expect(await plan("NOT-READY: A\nNOT-READY: B\n", ["A", "B"])).toEqual({
        ready: [],
        notReady: [
          { ref: "A", questions: ["What is missing for A?"] },
          { ref: "B", questions: ["What is missing for B?"] },
        ],
      });
      expect(existsSync(path.join(repo, ".agents", "tasks", "fake-plan"))).toBe(false);
    });
  });
});
