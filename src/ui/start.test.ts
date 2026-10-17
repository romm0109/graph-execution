import { describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { isAgentOutputLine, startUi } from "./start.js";

// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001B/;

describe("startUi in plain mode", () => {
  it("prints one readable line per event when stdout is not a TTY", () => {
    const events = new RunEmitter();
    const lines: string[] = [];
    const stdout = { isTTY: false } as NodeJS.WriteStream;
    const ui = startUi({
      events,
      layers: [["1"], ["2", "3"], ["4"]],
      attempts: 3,
      runId: "r1",
      provider: "fake",
      stdout,
      print: (line) => lines.push(line),
    });
    events.emit("task:start", { taskId: "2" });
    events.emit("task:retry", { taskId: "2", attempt: 2, attempts: 3, reason: { class: "crash", message: "agent exited with code 1" } });
    events.emit("task:status", { taskId: "2", status: "validating" });
    events.emit("task:merged", { taskId: "2", mergeCommit: "abc" });
    events.emit("output", { label: "2", text: "noise\n" });
    ui.log("[2] agent chatter");
    ui.log("all 4 task(s) merged");
    ui.stop();
    events.emit("task:start", { taskId: "3" });
    ui.log("aborted at run: interrupted");

    expect(lines.map((l) => l.replace(/^\[\d\d:\d\d:\d\d\] /, ""))).toEqual([
      "task 2 running",
      "task 2 retry 2/3 (agent exited with code 1)",
      "task 2 validating",
      "task 2 merged",
      "[2] agent chatter",
      "all 4 task(s) merged",
      "aborted at run: interrupted",
    ]);
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] task 2 running$/);
    for (const line of lines) expect(line).not.toMatch(ESCAPE);
  });
});

describe("startUi in plain mode, review phase", () => {
  it("prints the phase changes, the review agents and the final summary as plain lines", () => {
    const events = new RunEmitter();
    const lines: string[] = [];
    const ui = startUi({
      events,
      layers: [["1"]],
      attempts: 3,
      runId: "r1",
      provider: "fake",
      stdout: { isTTY: false } as NodeJS.WriteStream,
      print: (line) => lines.push(line),
    });
    events.emit("phase:change", { phase: "tasks" });
    events.emit("phase:change", { phase: "validate" });
    events.emit("phase:change", { phase: "review", round: 0, fixPasses: 3 });
    events.emit("agent:start", { agent: "reviewer", label: "code-r0" });
    events.emit("agent:retry", {
      agent: "reviewer",
      label: "code-r0",
      attempt: 2,
      attempts: 3,
      reason: { class: "invalid_report", message: "no report was written" },
    });
    events.emit("agent:end", { agent: "reviewer", label: "code-r0", ok: true });
    events.emit("phase:change", { phase: "fix", round: 2, fixPasses: 3 });
    events.emit("agent:start", { agent: "fixer", label: "fix-r2" });
    events.emit("agent:status", { agent: "fixer", status: "validating" });
    events.emit("agent:end", { agent: "fixer", label: "fix-r2", ok: false });
    events.emit("run:end", {
      runId: "r1",
      branch: "graph/r1",
      exitCode: 2,
      reports: [],
      fixPasses: 3,
      runDir: "/repo/.graph-execution/r1",
      abort: { step: "fix pass 2", message: "fix pass 2 failed after 3 attempts", hint: "graph-execution --resume --run r1" },
    });
    ui.stop();

    const stamped = lines.filter((l) => /^\[\d\d:\d\d:\d\d\] /.test(l)).map((l) => l.slice(11));
    expect(stamped).toEqual([
      "phase tasks",
      "phase validate",
      "phase review round 0",
      "code reviewer running (code-r0)",
      "code reviewer retry 2/3 (no report was written)",
      "code reviewer done",
      "phase fix pass 2/3",
      "fixer running (fix-r2)",
      "fixer validating",
      "fixer failed",
    ]);
    expect(lines).toContain("Run r1 aborted at fix pass 2: fix pass 2 failed after 3 attempts");
    expect(lines).toContain("branch graph/r1");
    expect(lines).toContain("  - resume the run: graph-execution --resume --run r1");
    for (const line of lines) expect(line).not.toMatch(ESCAPE);
  });
});

describe("isAgentOutputLine", () => {
  it("matches the [label] prefix of agent output lines only", () => {
    expect(isAgentOutputLine("[1] wrote 1.txt")).toBe(true);
    expect(isAgentOutputLine("[fixer fix-p1] done")).toBe(true);
    expect(isAgentOutputLine("task 1: running")).toBe(false);
    expect(isAgentOutputLine("[12:00:00]")).toBe(false);
  });
});
