import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { logFileName, RunStore, writeAgentLogs } from "./store.js";

const store = (events: RunEmitter, tailSize?: number): RunStore =>
  new RunStore(events, { taskIds: ["1", "2", "3", "4"], merged: ["1"], attempts: 3, tailSize });

describe("RunStore", () => {
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

  it("keeps only the last lines per agent in a ring buffer", () => {
    const events = new RunEmitter();
    const s = store(events, 3);
    events.emit("output", { label: "2", text: "a\nb\n" });
    events.emit("output", { label: "2", text: "c\n" });
    events.emit("output", { label: "2", text: "d\ne\n" });
    events.emit("output", { label: "3", text: "x\n" });
    expect(s.getState().tails["2"]).toEqual(["c", "d", "e"]);
    expect(s.getState().tails["3"]).toEqual(["x"]);
  });

  it("follows the latest started task until the focus is moved", () => {
    const events = new RunEmitter();
    const s = store(events);
    events.emit("task:start", { taskId: "2" });
    events.emit("task:start", { taskId: "3" });
    expect(s.getState().focus).toBe("3");
    // Focusable: merged 1, running 2 and 3, then other agents with output.
    events.emit("output", { label: "code-r0", text: "reviewing\n" });
    expect(s.focusable()).toEqual(["1", "2", "3", "code-r0"]);
    s.moveFocus(1);
    expect(s.getState().focus).toBe("code-r0");
    s.moveFocus(1);
    expect(s.getState().focus).toBe("1");
    s.moveFocus(-1);
    expect(s.getState().focus).toBe("code-r0");
    events.emit("task:start", { taskId: "4" });
    expect(s.getState().focus).toBe("code-r0");
  });

  it("folds the review agent events into the reviewer, tester and fixer nodes", () => {
    const events = new RunEmitter();
    const s = store(events);
    expect(s.getState().agents.reviewer).toMatchObject({ status: "pending", attempt: 0 });
    events.emit("agent:start", { agent: "reviewer", label: "code-r0" });
    expect(s.getState().agents.reviewer).toMatchObject({ status: "running", attempt: 1, label: "code-r0" });
    expect(s.getState().focus).toBe("code-r0");
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
    // Merged task 1, then the review agents that ran.
    expect(s.focusable()).toEqual(["1", "code-r0", "fix-r1"]);

    const end = { runId: "r", branch: "graph/r", exitCode: 2, reports: [], fixPasses: 3, runDir: "/r" };
    events.emit("run:end", end);
    expect(s.getState().summary).toEqual(end);
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
