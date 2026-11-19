import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixture, lines, log, readState, repo, spec } from "../__fixtures__/run-diamond.js";
import { gitOut } from "../__fixtures__/repo.js";
import { CONFIG_FILE } from "../config/config.js";
import { escalationRecordSchema } from "../escalation/schema.js";
import { loadTasks } from "../graph/load.js";
import { taskSchema, type Task } from "../graph/task.js";
import { createFakeProvider, type FakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { RunEmitter } from "./events.js";
import { RetryHub } from "./retry-hub.js";
import { run, taskBranchName } from "./run.js";
import { startup } from "./startup.js";

const ESCALATION = { reason: "r", evidence: "e", questions: [{ id: "q1", question: "A or B?" }] };

const node = (code: string): string => `node -e ${JSON.stringify(code)}`;
/** Fails unless the worktree's `status.txt` says `ok` (as in gates.test.ts). */
const CHECK_STATUS = node(
  `const s = require("fs").readFileSync("status.txt", "utf8").trim(); if (s !== "ok") { console.error("status is " + s); process.exit(1); }`,
);
const broken = { write: { "status.txt": "broken\n" } };

const taskCalls = (provider: FakeProvider, label?: string) =>
  provider.calls.filter((c) => c.role === "task" && (label === undefined || c.label === label));

async function start(
  script: unknown,
  opts: { tasks?: Task[]; config?: unknown; escalation?: boolean; hub?: boolean } = {},
) {
  if (opts.config !== undefined) await writeFile(path.join(repo, CONFIG_FILE), JSON.stringify(opts.config));
  const provider = createFakeProvider(fakeScriptSchema.parse(script));
  const hub = new RetryHub();
  const events = new RunEmitter();
  const tasks = opts.tasks ?? (await loadTasks(fixture("diamond")));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
  const done = run(ctx, tasks, {
    specPath: spec,
    tasksDir: fixture("diamond"),
    log,
    concurrency: 2,
    events,
    ...(opts.hub === false ? {} : { retry: hub, retryFailures: false }),
    ...(opts.escalation !== undefined ? { escalation: opts.escalation } : {}),
  });
  return { provider, hub, events, ctx, done };
}

describe("escalation", () => {
  it("pauses only the escalated task's branch, keeps its commits off the integration branch and waits", async () => {
    const { hub, ctx, done, events, provider } = await start({ "task:2": { attempts: [{ escalate: ESCALATION }] } });
    const opened: unknown[] = [];
    events.on("escalation:open", (e) => opened.push(e));
    await hub.whenEscalationWaiting();
    await vi.waitFor(async () => expect((await readState(ctx.runDir)).tasks["3"]!.status).toBe("merged"), { timeout: 15_000 });
    const state = await readState(ctx.runDir);
    expect(state.escalation).toBe(true);
    expect(state.tasks["1"]!.status).toBe("merged");
    expect(state.tasks["2"]!.status).toBe("escalated");
    expect(state.tasks["2"]!.worktree).toBeUndefined();
    expect(state.tasks["4"]!.status).toBe("pending");
    expect(state.escalations).toEqual([{ id: "E1", node: "2", status: "open" }]);
    const record = escalationRecordSchema.parse(
      JSON.parse(await readFile(path.join(ctx.runDir, "escalations", "E1.json"), "utf8")),
    );
    expect(record).toMatchObject({ ...ESCALATION, source: "agent", node: "2", attempt: 1, status: "open", branch: taskBranchName(ctx.runId, "2") });
    expect(await readdir(path.join(ctx.runDir, "escalations", "inbox"))).toEqual([]);
    expect(opened).toEqual([{ id: "E1", node: "2", source: "agent" }]);
    expect(lines).toContain("task 2: escalated (E1): r");
    // The escalated attempt's branch is kept, and not merged.
    expect(await gitOut(repo, ["branch", "--list", taskBranchName(ctx.runId, "2")])).toContain(taskBranchName(ctx.runId, "2"));
    expect(await gitOut(repo, ["log", "--format=%s", `graph/${ctx.runId}`])).not.toContain("Merge task 2");
    expect(taskCalls(provider, "4")).toHaveLength(0);
    // The prompt named the inbox path.
    expect(taskCalls(provider, "2")[0]!.prompt).toContain(path.join(ctx.runDir, "escalations", "inbox", "2-a1.json"));

    hub.quit();
    const result = await done;
    expect(result.exitCode).toBe(2);
    const after = await readState(ctx.runDir);
    expect(after.tasks["2"]!.status).toBe("escalated");
    expect(after.escalations).toEqual([{ id: "E1", node: "2", status: "open" }]);
    expect(after.status).toBe("aborted");
  });

  it("fails an attempt with an invalid escalation file and runs the next attempt", async () => {
    const { provider, done } = await start({ "task:2": { attempts: [{ escalate: "invalid" }, {}] } });
    const result = await done;
    expect(result.exitCode).toBe(0);
    const calls = taskCalls(provider, "2");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("escalation file is invalid");
    expect(lines.some((l) => l.includes("task 2: escalation file is invalid"))).toBe(true);
  });

  it("escalates a task whose validation still fails after all its fix rounds", async () => {
    const t1 = taskSchema.parse({ id: "1", content: "Do 1." });
    const { ctx, hub, done } = await start(
      { "task:1": { attempts: [broken, broken, broken, broken] } },
      { tasks: [t1], config: { validate: [CHECK_STATUS] } },
    );
    await hub.whenEscalationWaiting();
    const [record] = await (async () => {
      const text = await readFile(path.join(ctx.runDir, "escalations", "E1.json"), "utf8");
      return [escalationRecordSchema.parse(JSON.parse(text))];
    })();
    expect(record).toMatchObject({
      source: "validation",
      node: "1",
      reason: "validation still fails after 3 fix rounds",
      questions: [{ id: "q1", question: "How should task 1 proceed?" }],
    });
    expect(record!.evidence).toContain(CHECK_STATUS);
    expect(record!.evidence).toContain("status is broken");
    expect((await readState(ctx.runDir)).tasks["1"]!.status).toBe("escalated");
    hub.quit();
    expect((await done).exitCode).toBe(2);
  });

  it("aborts as before after exhausted validation with escalation off in the config", async () => {
    const t1 = taskSchema.parse({ id: "1", content: "Do 1." });
    const { ctx, done } = await start(
      { "task:1": { attempts: [broken, broken, broken, broken] } },
      { tasks: [t1], config: { validate: [CHECK_STATUS], escalation: false } },
    );
    const result = await done;
    expect(result.exitCode).toBe(2);
    const state = await readState(ctx.runDir);
    expect(state.escalation).toBe(false);
    expect(state.tasks["1"]!.status).toBe("failed");
    expect(state.escalations).toEqual([]);
    expect(lines.some((l) => l.startsWith("aborted at task 1: validation failed after 3 rounds"))).toBe(true);
    expect(existsSync(path.join(ctx.runDir, "escalations"))).toBe(false);
  });

  it("puts the escalation instruction in the task prompt only when escalation is on", async () => {
    const on = await start({});
    expect((await on.done).exitCode).toBe(0);
    const prompt = taskCalls(on.provider, "1")[0]!.prompt;
    expect(prompt).toContain("stop and escalate");
    expect(prompt).toContain(path.join(on.ctx.runDir, "escalations", "inbox", "1-a1.json"));
    expect(taskCalls(on.provider, "1")[0]!.escalationFile).toBe(path.join(on.ctx.runDir, "escalations", "inbox", "1-a1.json"));
  });

  it("ignores an escalation file and leaves the prompt without it when escalation is off", async () => {
    const off = await start({ "task:2": { attempts: [{ escalate: ESCALATION }, {}] } }, { escalation: false });
    expect((await off.done).exitCode).toBe(0);
    for (const call of taskCalls(off.provider)) {
      expect(call.prompt).not.toMatch(/escalat/i);
      expect(call.escalationFile).toBeUndefined();
    }
    expect((await readState(off.ctx.runDir)).escalation).toBe(false);
  });
});
