import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { blocker, repo, runReview } from "../__fixtures__/review-phase.js";
import { escalationRecordSchema } from "../escalation/schema.js";
import { loadEscalations } from "../escalation/store.js";
import { createFakeProvider, type FakeProvider } from "../providers/fake.js";
import { applyResolutionOffline } from "../escalation/resolve.js";
import { resume } from "../runner/run.js";
import { RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";

const ESCALATION = { reason: "r", evidence: "e", questions: [{ id: "q1", question: "?" }] };

/** Round 0 finds a blocker, so fix pass 1 runs; its fixer escalates on its first attempt. */
const script = (extra: Record<string, unknown> = {}) => ({
  "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
  "fixer:fix-r1": { attempts: [{ escalate: ESCALATION }] },
  ...extra,
});

const fixerCalls = (p: FakeProvider) => p.calls.filter((c) => c.role === "fixer");

const runDirOf = async (): Promise<string> => {
  const root = path.join(repo, ".graph-execution");
  return path.join(root, (await readdir(root))[0]!);
};
const readState = async (runDir: string) => JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));

describe("fixer escalation", () => {
  it("pauses the review at fix and reruns the fixer with the decision on continue", async () => {
    const hub = new RetryHub();
    const events = new RunEmitter();
    const statuses: string[] = [];
    const opened: unknown[] = [];
    events.on("agent:status", ({ agent, status }) => agent === "fixer" && statuses.push(status));
    events.on("agent:end", ({ agent, ok }) => agent === "fixer" && statuses.push(`end ${ok}`));
    events.on("escalation:open", (e) => opened.push(e));
    const running = runReview(script(), { retry: hub, events });
    await hub.whenEscalationWaiting();
    const runDir = await runDirOf();
    const state = await readState(runDir);
    expect(state.review).toMatchObject({ phase: "fix", round: 1 });
    expect(state.escalations).toEqual([{ id: "E1", node: "fixer", status: "open" }]);
    const [record] = await loadEscalations(runDir);
    expect(escalationRecordSchema.parse(record)).toMatchObject({ id: "E1", node: "fixer", status: "open", attempt: 1 });
    expect(opened).toEqual([{ id: "E1", node: "fixer", source: "agent" }]);
    expect(statuses).toEqual(["escalated"]);

    expect(await hub.submitResolution({ escalationIds: ["E1"], action: "continue", guidance: "keep it" })).toEqual({
      ok: true,
      requeued: [],
    });
    const { result, provider, ctx } = await running;
    expect(result.exitCode).toBe(0);
    const calls = fixerCalls(provider);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toContain(path.join("escalations", "inbox", "fix-r1-a1.json"));
    expect(calls[0]!.prompt).not.toContain("## Decision");
    expect(calls[1]!.prompt).toContain("## Decision");
    expect(calls[1]!.prompt).toContain("keep it");
    expect(statuses).toEqual(["escalated", "end true"]);
    expect((await readState(ctx.runDir)).escalations).toEqual([{ id: "E1", node: "fixer", status: "resolved" }]);
  });

  it("reruns a reopened task on change, then restarts the review with a fresh fix budget", async () => {
    const hub = new RetryHub();
    const running = runReview(script(), { retry: hub, config: { fixPasses: 1 } });
    await hub.whenEscalationWaiting();
    const runDir = await runDirOf();
    expect(await hub.submitResolution({ escalationIds: ["E1"], action: "change", reopen: ["1"] })).toEqual({
      ok: true,
      requeued: ["1"],
    });
    const { result, provider } = await running;
    expect(result.exitCode).toBe(0);
    expect(provider.calls.filter((c) => c.role === "task" && c.label === "1").length).toBeGreaterThanOrEqual(2);
    const rerun = provider.calls.filter((c) => c.role === "task" && c.label === "1").at(-1)!;
    expect(rerun.prompt).toContain("## Decision");
    // The escalated pass never committed: the review starts over at its round, with the budget based there.
    const state = await readState(runDir);
    expect(state.review).toMatchObject({ phase: "done", round: 1, budgetBase: 1 });
    expect(provider.calls.filter((c) => c.role === "reviewer").map((c) => c.label)).toEqual(["code-r0", "code-r1"]);
    expect(fixerCalls(provider)).toHaveLength(1);
  });

  it("quit while waiting exits 2 and leaves the review at fix; --resume returns to the wait", async () => {
    const hub = new RetryHub();
    const running = runReview(script(), { retry: hub });
    await hub.whenEscalationWaiting();
    hub.quit();
    const { result, ctx } = await running;
    expect(result.exitCode).toBe(2);
    const state = await readState(ctx.runDir);
    expect(state.review).toMatchObject({ phase: "fix", round: 1 });
    expect(state.escalations).toEqual([{ id: "E1", node: "fixer", status: "open" }]);

    // `--resume` goes back to the same wait without running the fixer first, and continues from it.
    const provider = createFakeProvider({});
    const hub2 = new RetryHub();
    const resumed = resume({ cwd: repo, runId: ctx.runId, providerInstance: provider, retry: hub2, log: () => {} });
    await hub2.whenEscalationWaiting();
    expect(fixerCalls(provider)).toHaveLength(0);
    await hub2.submitResolution({ escalationIds: ["E1"], action: "continue", guidance: "after resume" });
    expect((await resumed).exitCode).toBe(0);
    expect(fixerCalls(provider)[0]!.prompt).toContain("after resume");
  });

  it("keeps a continue's guidance when it was applied to the stopped run (F2)", async () => {
    const hub = new RetryHub();
    const running = runReview(script(), { retry: hub });
    await hub.whenEscalationWaiting();
    hub.quit();
    const { ctx } = await running;
    const { requeued } = await applyResolutionOffline(ctx.runDir, { escalationIds: ["E1"], action: "continue", guidance: "keep GraphQL" });
    expect(requeued).toEqual([]);
    expect((await loadEscalations(ctx.runDir))[0]).toMatchObject({ round: 1, status: "resolved" });

    const provider = createFakeProvider({});
    const resumed = await resume({ cwd: repo, runId: ctx.runId, providerInstance: provider, retry: new RetryHub(), log: () => {} });
    expect(resumed.exitCode).toBe(0);
    const [call] = fixerCalls(provider);
    expect(call!.prompt).toContain("## Decision");
    expect(call!.prompt).toContain("keep GraphQL");
  });

  it("abort ends the run as aborted", async () => {
    const hub = new RetryHub();
    const running = runReview(script(), { retry: hub });
    await hub.whenEscalationWaiting();
    await hub.submitResolution({ escalationIds: ["E1"], action: "abort" });
    const { result, ctx } = await running;
    expect(result.exitCode).toBe(2);
    await vi.waitFor(async () => expect((await readState(ctx.runDir)).status).toBe("aborted"), { timeout: 15_000 });
  });

  it("gives the gate fixer no escalation instruction", async () => {
    const UNTIL_FIXED = `node -e ${JSON.stringify(
      `if (!require("fs").existsSync("fix-r0-v1.txt")) { console.error("broken"); process.exit(4); }`,
    )}`;
    const hub = new RetryHub();
    const { result, provider } = await runReview(
      {},
      { config: { validate: [UNTIL_FIXED] }, noTaskValidation: true, retry: hub },
    );
    expect(result.exitCode).toBe(0);
    const gate = fixerCalls(provider).find((c) => c.label === "fix-r0-v1")!;
    expect(gate.prompt).not.toContain("escalate");
    expect(gate.escalationFile).toBeUndefined();
  });

  it("gives the fixer no escalation instruction without a hub", async () => {
    const { result, provider } = await runReview({ "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] } });
    expect(result.exitCode).toBe(0);
    const [call] = fixerCalls(provider);
    expect(call!.prompt).not.toContain("escalate");
    expect(call!.escalationFile).toBeUndefined();
  });
});
