import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { failedNodeIds, logFileName, RunStore, writeAgentLogs } from "./store.js";

const store = (events: RunEmitter): RunStore =>
  new RunStore(events, { taskIds: ["1", "2", "3", "4"], merged: ["1"], attempts: 3 });

describe("RunStore", () => {
  it("stamps startedAt on the first run and endedAt when a node finishes", () => {
    const events = new RunEmitter();
    const s = store(events);
    expect(s.getState().nodes["2"]!.startedAt).toBeUndefined();
    events.emit("task:start", { taskId: "2" } as never);
    const started = s.getState().nodes["2"]!.startedAt;
    expect(started).toBeTypeOf("number");
    expect(s.getState().nodes["2"]!.endedAt).toBeUndefined();
    events.emit("task:failed", { taskId: "2" } as never);
    expect(s.getState().nodes["2"]!.endedAt).toBeTypeOf("number");
    events.emit("task:retry", { taskId: "2", attempt: 2, attempts: 3 } as never);
    expect(s.getState().nodes["2"]!.startedAt).toBe(started);
    expect(s.getState().nodes["2"]!.endedAt).toBeUndefined();
    events.emit("task:merged", { taskId: "2" } as never);
    expect(s.getState().nodes["2"]!.startedAt).toBe(started);
    expect(s.getState().nodes["2"]!.endedAt).toBeTypeOf("number");
  });

  it("folds nodeChanges into task nodes and review agents, ignoring unknown ids", () => {
    const events = new RunEmitter();
    const s = store(events);
    const changes = { files: [{ path: "a", added: 1, deleted: 0 }], total: { added: 1, deleted: 0, files: 1 } };
    events.emit("nodeChanges", { nodeId: "2", changes });
    events.emit("nodeChanges", { nodeId: "@fixer", changes });
    events.emit("nodeChanges", { nodeId: "nope", changes });
    expect(s.getState().nodes["2"]!.changes).toBe(changes);
    expect(s.getState().agents.fixer.changes).toBe(changes);
    expect(s.getState().nodes["nope"]).toBeUndefined();
  });

  it("puts the tester's cases from review:end on agents.tester.testPlan", () => {
    const events = new RunEmitter();
    const s = store(events);
    const base = { reviewer: "tester" as const, findings: [] };
    events.emit("review:end", { round: 1, reports: [{ ...base, round: 1 }] });
    expect(s.getState().agents.tester.testPlan).toBeUndefined();
    const c1 = [{ id: "P1", verdict: "fail" as const, evidence: "e", title: "T", priority: "must" as const }];
    events.emit("review:end", { round: 1, reports: [{ ...base, round: 1, cases: c1 }] });
    expect(s.getState().agents.tester.testPlan).toEqual({ round: 1, cases: c1 });
    events.emit("run:restart", {} as never);
    expect(s.getState().agents.tester.testPlan?.round).toBe(1);
    const c2 = [{ id: "P1", verdict: "pass" as const }];
    events.emit("review:end", { round: 2, reports: [{ ...base, round: 2, cases: c2 }] });
    expect(s.getState().agents.tester.testPlan).toEqual({ round: 2, cases: c2 });
  });

  it("folds the events into node states", () => {
    const events = new RunEmitter();
    const s = store(events);
    expect(s.getState().nodes["1"]!.status).toBe("merged");
    expect(s.getState().nodes["2"]!.status).toBe("pending");

    events.emit("task:start", { taskId: "2" });
    expect(s.getState().nodes["2"]).toMatchObject({ status: "running", attempt: 1 });
    events.emit("task:retry", { taskId: "2", attempt: 2, attempts: 3, reason: { class: "crash", message: "boom" } });
    expect(s.getState().nodes["2"]).toMatchObject({ status: "running", attempt: 2, attempts: 3 });
    events.emit("task:status", { taskId: "2", status: "validating" });
    expect(s.getState().nodes["2"]!.status).toBe("validating");
    events.emit("task:status", { taskId: "2", status: "merging" });
    events.emit("task:merged", { taskId: "2", mergeCommit: "abc" });
    expect(s.getState().nodes["2"]!.status).toBe("merged");
    events.emit("task:failed", { taskId: "3", error: new Error("x") });
    expect(s.getState().nodes["3"]!.status).toBe("failed");
    events.emit("phase:change", { phase: "review", round: 0, fixPasses: 3 });
    expect(s.getState().phase).toEqual({ phase: "review", round: 0, fixPasses: 3 });
  });

  it("counts the attempts stopped for a loop on task and review agent nodes", () => {
    const events = new RunEmitter();
    const s = store(events);
    events.emit("task:start", { taskId: "2" });
    events.emit("task:retry", { taskId: "2", attempt: 2, attempts: 3, reason: { class: "crash", message: "boom" } });
    expect(s.getState().nodes["2"]!.loops).toBeUndefined();
    expect(s.getState().nodes["2"]!.lastLoop).toBeUndefined();
    events.emit("task:retry", { taskId: "2", attempt: 3, attempts: 3, reason: { class: "loop", message: "first" } });
    expect(s.getState().nodes["2"]).toMatchObject({ loops: 1, lastLoop: "first" });
    events.emit("task:retry", { taskId: "2", attempt: 3, attempts: 4, reason: { class: "loop", message: "second" } });
    expect(s.getState().nodes["2"]).toMatchObject({ loops: 2, lastLoop: "second" });
    events.emit("agent:retry", {
      agent: "reviewer",
      label: "code-r0",
      attempt: 2,
      attempts: 3,
      reason: { class: "loop", message: "again" },
    });
    expect(s.getState().agents.reviewer).toMatchObject({ loops: 1, lastLoop: "again" });
  });

  it("follows the validation gate and the apply step, and settles what never ran at the end", () => {
    const events = new RunEmitter();
    const s = store(events);
    events.emit("phase:change", { phase: "validate" });
    expect(s.getState().gate.status).toBe("running");
    events.emit("phase:change", { phase: "review", round: 0, fixPasses: 3 });
    expect(s.getState().gate.status).toBe("done");
    events.emit("merge:status", { status: "running" });
    expect(s.getState().merge.status).toBe("running");
    events.emit("merge:status", { status: "done" });
    events.emit("run:end", { runId: "r", branch: "graph/r", exitCode: 0, reports: [], fixPasses: 3, runDir: "/r" });
    expect(s.getState().merge.status).toBe("done");
    expect(s.getState().agents.fixer.status).toBe("skipped");
  });

  it("folds the review agent events into the reviewer, tester and fixer nodes", () => {
    const events = new RunEmitter();
    const s = store(events);
    expect(s.getState().agents.reviewer).toMatchObject({ status: "pending", attempt: 0 });
    events.emit("agent:start", { agent: "reviewer", label: "code-r0" });
    expect(s.getState().agents.reviewer).toMatchObject({ status: "running", attempt: 1, label: "code-r0" });
    events.emit("agent:retry", {
      agent: "reviewer",
      label: "code-r0",
      attempt: 3,
      attempts: 3,
      reason: { class: "invalid_report", message: "bad" },
    });
    expect(s.getState().agents.reviewer).toMatchObject({ status: "running", attempt: 3 });
    events.emit("agent:end", { agent: "reviewer", label: "code-r0", ok: true });
    expect(s.getState().agents.reviewer.status).toBe("done");
    events.emit("agent:start", { agent: "fixer", label: "fix-r1" });
    events.emit("agent:status", { agent: "fixer", status: "validating" });
    expect(s.getState().agents.fixer).toMatchObject({ status: "validating", label: "fix-r1" });
    events.emit("agent:end", { agent: "fixer", label: "fix-r1", ok: false });
    expect(s.getState().agents.fixer.status).toBe("failed");

    const end = { runId: "r", branch: "graph/r", exitCode: 2, reports: [], fixPasses: 3, runDir: "/r" };
    events.emit("run:end", end);
    expect(s.getState().summary).toEqual(end);
  });

  it("records the human's decision when the run leaves the review wait", () => {
    const events = new RunEmitter();
    const s = store(events);
    events.emit("review:waiting", { round: 1, reviewRound: 0, blocking: [] });
    expect(s.getState().review).toMatchObject({ waiting: true, round: 1 });
    events.emit("review:decided", { decision: "changes" });
    expect(s.getState().review).toMatchObject({ waiting: false, decision: "changes" });
    events.emit("review:waiting", { round: 2, reviewRound: 1, blocking: [] });
    events.emit("review:decided", { decision: "apply" });
    expect(s.getState().review).toMatchObject({ waiting: false, round: 2, decision: "apply" });
  });

  it("stops listening once disposed", () => {
    const events = new RunEmitter();
    const s = store(events);
    s.dispose();
    events.emit("task:start", { taskId: "2" });
    expect(s.getState().nodes["2"]!.status).toBe("pending");
  });
});

describe("writeAgentLogs", () => {
  it("appends every agent's output to logs/<label>.log, creating the folder", async () => {
    const logsDir = path.join(await mkdtemp(path.join(tmpdir(), "ge-logs-")), "run", "logs");
    const events = new RunEmitter();
    const stop = writeAgentLogs(events, logsDir);
    events.emit("output", { label: "1", text: "first\n" });
    events.emit("output", { label: "1", text: "second" });
    events.emit("output", { label: "fix pass 1", text: "fixing\n" });
    stop();
    events.emit("output", { label: "1", text: "after stop\n" });

    expect(await readFile(path.join(logsDir, "1.log"), "utf8")).toBe("first\nsecond\n");
    expect(logFileName("fix pass 1")).toBe("fix-pass-1.log");
    expect((await readdir(logsDir)).sort()).toEqual(["1.log", "fix-pass-1.log"]);
  });
});

describe("retry folds", () => {
  const end = { runId: "r", branch: "graph/r", exitCode: 2, reports: [], fixPasses: 3, runDir: "/r" };

  it("resets non-finished nodes and clears the summary on run:restart", () => {
    const events = new RunEmitter();
    const s = store(events);
    events.emit("task:start", { taskId: "2" });
    events.emit("task:start", { taskId: "3" });
    events.emit("task:failed", { taskId: "2", error: new Error("x") });
    events.emit("run:end", end);
    expect(s.getState().summary).toBeDefined();
    events.emit("retry:available", { nodes: ["2"] });
    expect(s.getState().retryable).toEqual(["2"]);
    events.emit("run:restart", { nodeId: "2" });
    const state = s.getState();
    expect(state.summary).toBeUndefined();
    expect(state.retryable).toEqual([]);
    expect(state.nodes["1"]!.status).toBe("merged");
    expect(state.nodes["2"]).toMatchObject({ status: "pending", attempt: 0 });
    expect(state.nodes["3"]).toMatchObject({ status: "pending", attempt: 0 });
    expect(state.merge.status).toBe("pending");
  });

  it("lists failed tasks first, then the pipeline nodes", () => {
    const events = new RunEmitter();
    const s = store(events);
    events.emit("task:failed", { taskId: "3", error: new Error("x") });
    events.emit("agent:end", { agent: "tester", label: "tester-r0", ok: false });
    events.emit("agent:end", { agent: "reviewer", label: "code-r0", ok: true });
    events.emit("merge:status", { status: "failed" });
    expect(failedNodeIds(s.getState())).toEqual(["3", "@tester", "@merge"]);
  });

  it("gives every enabled reviewer from a reviewers file its own node, titled with its name", () => {
    const events = new RunEmitter();
    const s = new RunStore(events, {
      taskIds: ["1"],
      attempts: 3,
      reviewers: [
        { id: "code", name: "Code review" },
        { id: "security", name: "Security" },
      ],
      customReviewers: true,
    });
    expect(s.getState().reviewers).toEqual([
      { id: "code", agent: "reviewer", node: "@reviewer", title: "Code review" },
      { id: "security", agent: "security", node: "@security", title: "Security" },
    ]);
    expect(s.getState().agents.security).toMatchObject({ status: "pending", attempt: 0, attempts: 3, label: "security" });
    events.emit("agent:start", { agent: "security", label: "security-r0" });
    expect(s.getState().agents.security).toMatchObject({ status: "running", label: "security-r0" });
    events.emit("nodeChanges", { nodeId: "@security", changes: { files: [], total: { added: 1, deleted: 0, files: 1 } } });
    expect(s.getState().agents.security!.changes?.total.added).toBe(1);
    events.emit("agent:end", { agent: "security", label: "security-r0", ok: false });
    expect(failedNodeIds(s.getState())).toEqual(["@security"]);
    events.emit("agent:start", { agent: "unknown", label: "unknown-r0" });
    expect(s.getState().agents.unknown).toBeUndefined();
    events.emit("run:restart", {} as never);
    expect(s.getState().agents.security!.status).toBe("pending");
    expect(failedNodeIds(s.getState())).toEqual([]);
  });

  it("titles the built-in reviewers as before without a reviewers file", () => {
    const s = store(new RunEmitter());
    expect(s.getState().reviewers.map((r) => [r.node, r.title])).toEqual([
      ["@reviewer", "code reviewer"],
      ["@tester", "live tester"],
    ]);
  });
});

describe("RunStore plan view", () => {
  const plan = {
    status: "planning" as const,
    attempt: 1,
    attempts: 3,
    refs: [{ ref: "KAN-1" }],
    questions: [],
    dropped: [],
    branch: "graph/r1",
  };

  it("folds plan:update into getState().plan", () => {
    const events = new RunEmitter();
    const s = new RunStore(events, { taskIds: [], attempts: 3 });
    expect(s.getState().plan).toBeUndefined();
    events.emit("plan:update", plan);
    expect(s.getState().plan).toEqual(plan);
    events.emit("plan:update", { ...plan, status: "awaiting-approval", name: "x" });
    expect(s.getState().plan?.status).toBe("awaiting-approval");
    expect(s.getState().plan?.name).toBe("x");
  });

  it("seeds a new store with the plan option", () => {
    const s = new RunStore(new RunEmitter(), { taskIds: ["1"], attempts: 3, plan: { ...plan, status: "running", dropped: ["KAN-2"] } });
    expect(s.getState().plan?.status).toBe("running");
    expect(s.getState().plan?.dropped).toEqual(["KAN-2"]);
  });
});
