import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixture, log, readState, repo, spec } from "../__fixtures__/run-diamond.js";
import { gitOut } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, type FakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { RunEmitter } from "./events.js";
import { RetryHub } from "./retry-hub.js";
import { integrationBranchName, run } from "./run.js";
import { startup } from "./startup.js";

const ESCALATION = { reason: "A or B is not decided", evidence: "spec.md:1", questions: [{ id: "q1", question: "A or B?" }] };

const taskCalls = (provider: FakeProvider, label: string) =>
  provider.calls.filter((c) => c.role === "task" && c.label === label);

async function start(script: unknown) {
  const provider = createFakeProvider(fakeScriptSchema.parse(script));
  const hub = new RetryHub();
  const events = new RunEmitter();
  const tasks = await loadTasks(fixture("diamond"));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
  const done = run(ctx, tasks, {
    specPath: spec,
    tasksDir: fixture("diamond"),
    log,
    concurrency: 2,
    events,
    retry: hub,
    retryFailures: false,
  });
  return { provider, hub, events, ctx, done };
}

/** Waits until the run has `n` open escalations and nothing runs; returns escalation id per escalated task. */
async function openEscalations(runDir: string, n: number): Promise<Record<string, string>> {
  await vi.waitFor(
    async () => {
      const state = await readState(runDir);
      expect(state.escalations.filter((e) => e.status === "open")).toHaveLength(n);
      expect(Object.values(state.tasks).some((t) => t.status === "running" || t.status === "merging" || t.status === "validating")).toBe(false);
    },
    { timeout: 15_000 },
  );
  const state = await readState(runDir);
  return Object.fromEntries(state.escalations.filter((e) => e.status === "open").map((e) => [e.node, e.id]));
}

describe("resolutions", () => {
  it("continue reruns only the escalated task with the decision, then its dependents", async () => {
    const { hub, ctx, done, provider, events } = await start({ "task:2": { attempts: [{ escalate: ESCALATION }, {}] } });
    const resolved: unknown[] = [];
    events.on("escalation:resolved", (e) => resolved.push(e));
    await openEscalations(ctx.runDir, 1);
    const before = await readState(ctx.runDir);
    expect(before.tasks["3"]!.status).toBe("merged");

    const result = await hub.submitResolution({ escalationIds: ["E1"], action: "continue", guidance: "use B" });
    expect(result).toEqual({ ok: true, requeued: ["2"] });
    const end = await done;
    expect(end.exitCode).toBe(0);

    const prompt = taskCalls(provider, "2").at(-1)!.prompt;
    expect(prompt).toContain("## Decision");
    expect(prompt).toContain("use B");
    expect(prompt).toContain("A or B?");
    expect(taskCalls(provider, "2")).toHaveLength(2);
    expect(taskCalls(provider, "1")).toHaveLength(1);
    expect(taskCalls(provider, "3")).toHaveLength(1);
    expect(taskCalls(provider, "4")).toHaveLength(1);
    const after = await readState(ctx.runDir);
    expect(["applied", "done"]).toContain(after.status);
    expect(after.tasks["1"]!.mergeCommit).toBe(before.tasks["1"]!.mergeCommit);
    expect(after.tasks["3"]!.mergeCommit).toBe(before.tasks["3"]!.mergeCommit);
    expect(after.escalations).toEqual([{ id: "E1", node: "2", status: "resolved" }]);
    expect(after.tasksSource).toBe("folder");
    expect(resolved).toEqual([{ ids: ["E1"], action: "continue" }]);
  });

  it("change edits a pending task, adds a task and reopens a merged one, in the run's own task copy", async () => {
    const original = await Promise.all(
      (await readdir(fixture("diamond"))).sort().map((f) => readFile(path.join(fixture("diamond"), f), "utf8")),
    );
    const { hub, ctx, done, provider, events } = await start({ "task:2": { attempts: [{ escalate: ESCALATION }, {}] } });
    const changed: unknown[] = [];
    events.on("graph:changed", (e) => changed.push(e));
    await openEscalations(ctx.runDir, 1);

    const result = await hub.submitResolution({
      escalationIds: ["E1"],
      action: "change",
      guidance: "Do B.",
      editTasks: [{ id: "4", content: "Integrate B only." }],
      addTasks: [{ id: "5", content: "Document it.", dependencies: ["4"] }],
      reopen: ["1"],
    });
    expect(result).toEqual({ ok: true, requeued: ["2", "1"] });
    expect((await done).exitCode).toBe(0);

    expect(taskCalls(provider, "1")).toHaveLength(2);
    expect(taskCalls(provider, "1")[1]!.prompt).toContain("already merged into this checkout");
    expect(taskCalls(provider, "3")).toHaveLength(1);
    expect(taskCalls(provider, "4")[0]!.prompt).toContain("Integrate B only.");
    expect(taskCalls(provider, "5")).toHaveLength(1);
    expect((await readdir(path.join(ctx.runDir, "tasks"))).sort()).toEqual(["1.json", "2.json", "3.json", "4.json", "5.json"]);
    // The agents' reference copy is the effective set.
    expect(await readFile(path.join(ctx.runDir, "context", "tasks", "5.json"), "utf8")).toContain("Document it.");
    const now = await Promise.all(
      (await readdir(fixture("diamond"))).sort().map((f) => readFile(path.join(fixture("diamond"), f), "utf8")),
    );
    expect(now).toEqual(original);
    const state = await readState(ctx.runDir);
    expect(state.tasksSource).toBe("run");
    expect(["applied", "done"]).toContain(state.status);
    expect(state.tasks["5"]!.status).toBe("merged");
    expect(changed).toEqual([
      expect.objectContaining({ taskIds: ["1", "2", "3", "4", "5"], layers: [["1"], ["2", "3"], ["4"], ["5"]] }),
    ]);
  });

  it("two escalations block their own branches; a dependent of both waits for both", async () => {
    const script = { "task:2": { attempts: [{ escalate: ESCALATION }, {}] }, "task:3": { attempts: [{ escalate: ESCALATION }, {}] } };
    const { hub, ctx, done, provider } = await start(script);
    const ids = await openEscalations(ctx.runDir, 2);
    expect(await hub.submitResolution({ escalationIds: [ids["2"]!], action: "continue" })).toEqual({ ok: true, requeued: ["2"] });
    await vi.waitFor(async () => expect((await readState(ctx.runDir)).tasks["2"]!.status).toBe("merged"), { timeout: 15_000 });
    expect(taskCalls(provider, "4")).toHaveLength(0);
    expect((await readState(ctx.runDir)).tasks["3"]!.status).toBe("escalated");
    expect(await hub.submitResolution({ escalationIds: [ids["3"]!], action: "continue" })).toEqual({ ok: true, requeued: ["3"] });
    expect((await done).exitCode).toBe(0);
    expect(taskCalls(provider, "4")).toHaveLength(1);
  });

  it("one resolution closes several escalations", async () => {
    const script = { "task:2": { attempts: [{ escalate: ESCALATION }, {}] }, "task:3": { attempts: [{ escalate: ESCALATION }, {}] } };
    const { hub, ctx, done } = await start(script);
    await openEscalations(ctx.runDir, 2);
    const result = await hub.submitResolution({ escalationIds: ["E1", "E2"], action: "continue" });
    expect(result.ok).toBe(true);
    expect(result.ok && [...result.requeued].sort()).toEqual(["2", "3"]);
    expect((await done).exitCode).toBe(0);
    expect((await readState(ctx.runDir)).escalations.map((e) => e.status)).toEqual(["resolved", "resolved"]);
  });

  it("refuses stale or invalid resolutions", async () => {
    const { hub, ctx, done } = await start({ "task:2": { attempts: [{ escalate: ESCALATION }, {}] } });
    await openEscalations(ctx.runDir, 1);
    expect(
      await hub.submitResolution({ escalationIds: ["E1"], action: "change", editTasks: [{ id: "2", dependencies: ["4"] }] }),
    ).toMatchObject({ ok: false, status: 400, code: "graph" });
    expect(
      await hub.submitResolution({ escalationIds: ["E1"], action: "change", editTasks: [{ id: "1", content: "again" }] }),
    ).toMatchObject({ ok: false, status: 409, code: "task_started" });
    expect(await hub.submitResolution({ escalationIds: ["E1"], action: "continue" })).toMatchObject({ ok: true });
    expect(await hub.submitResolution({ escalationIds: ["E1"], action: "continue" })).toMatchObject({
      ok: false,
      status: 409,
      code: "not_open",
    });
    expect((await done).exitCode).toBe(0);
  });

  it("abort ends the run as aborted and keeps graph/<run-id>", async () => {
    const { hub, ctx, done } = await start({ "task:2": { attempts: [{ escalate: ESCALATION }] } });
    await openEscalations(ctx.runDir, 1);
    expect(await hub.submitResolution({ escalationIds: ["E1"], action: "abort" })).toEqual({ ok: true, requeued: [] });
    expect((await done).exitCode).toBe(2);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("aborted");
    expect(state.escalations).toEqual([{ id: "E1", node: "2", status: "resolved" }]);
    expect(await gitOut(repo, ["branch", "--list", integrationBranchName(ctx.runId)])).toContain(integrationBranchName(ctx.runId));
    // The run is over: nothing handles resolutions any more.
    expect(await hub.submitResolution({ escalationIds: ["E1"], action: "continue" })).toMatchObject({ code: "not_waiting" });
  });
});
