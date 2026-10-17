import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { App, formatElapsed } from "./App.js";
import { RunStore } from "./store.js";

const layers = [["1"], ["2", "3"], ["4"]];
const ARROW_RIGHT = "\u001B[C";
const ARROW_LEFT = "\u001B[D";
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const events = new RunEmitter();
  const store = new RunStore(events, { taskIds: layers.flat(), attempts: 3 });
  const app = render(<App store={store} layers={layers} runId="20260101-000000-abcd" provider="fake" startedAt={Date.now()} />);
  cleanup = app.unmount;
  return { events, store, app };
}

describe("App", () => {
  it("shows the header, every node of the diamond and the review nodes as pending", () => {
    const { app } = setup();
    const frame = app.lastFrame()!;
    expect(frame).toContain("run 20260101-000000-abcd");
    expect(frame).toContain("provider fake");
    expect(frame).toMatch(/tasks .*→ validate → review → fixer/);
    for (const id of ["1", "2", "3", "4"]) expect(frame).toContain(`task ${id}`);
    for (const title of ["code reviewer", "live tester", "fixer"]) expect(frame).toContain(title);
    expect(frame.match(/pending/g)).toHaveLength(7);
  });

  it("shows the state text of each status, two running at once", async () => {
    const { events, app } = setup();
    events.emit("task:start", { taskId: "1" });
    events.emit("task:status", { taskId: "1", status: "validating" });
    events.emit("task:status", { taskId: "1", status: "merging" });
    events.emit("task:merged", { taskId: "1", mergeCommit: "abc" });
    events.emit("task:start", { taskId: "2" });
    events.emit("task:start", { taskId: "3" });
    await tick();
    let frame = app.lastFrame()!;
    expect(frame).toContain("merged");
    expect(frame.match(/running/g)).toHaveLength(2);
    expect(frame).toContain("pending");

    events.emit("task:status", { taskId: "2", status: "validating" });
    events.emit("task:status", { taskId: "3", status: "merging" });
    await tick();
    frame = app.lastFrame()!;
    expect(frame).toContain("validating");
    expect(frame).toContain("merging");

    events.emit("task:failed", { taskId: "3", error: new Error("boom") });
    await tick();
    expect(app.lastFrame()).toContain("failed");
  });

  it("shows retry N/3 from the second attempt", async () => {
    const { events, app } = setup();
    events.emit("task:start", { taskId: "1" });
    events.emit("task:retry", { taskId: "1", attempt: 2, attempts: 3, reason: { class: "no_commit", message: "no commit" } });
    await tick();
    expect(app.lastFrame()).toContain("retry 2/3");
  });

  it("shows the focused agent's latest output and switches with the arrow keys", async () => {
    const { events, app } = setup();
    events.emit("task:start", { taskId: "2" });
    events.emit("task:start", { taskId: "3" });
    events.emit("output", { label: "2", text: "two says hi\n" });
    events.emit("output", { label: "3", text: "three says hi\n" });
    await tick();
    expect(app.lastFrame()).toContain("output of 3");
    expect(app.lastFrame()).toContain("three says hi");
    expect(app.lastFrame()).not.toContain("two says hi");

    app.stdin.write(ARROW_LEFT);
    await tick();
    expect(app.lastFrame()).toContain("output of 2");
    expect(app.lastFrame()).toContain("two says hi");
    expect(app.lastFrame()).not.toContain("three says hi");

    app.stdin.write(ARROW_RIGHT);
    await tick();
    expect(app.lastFrame()).toContain("three says hi");
  });
});

describe("formatElapsed", () => {
  it("formats minutes and hours", () => {
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m 05s");
  });
});

describe("App in the review phase", () => {
  it("shows the review rounds and fix pass N/3 in the phase bar", async () => {
    const { events, app } = setup();
    events.emit("phase:change", { phase: "validate" });
    await tick();
    expect(app.lastFrame()).toContain(" validate ");
    events.emit("phase:change", { phase: "review", round: 0, fixPasses: 3 });
    await tick();
    expect(app.lastFrame()).toMatch(/validate → +review +→ fixer/);
    events.emit("phase:change", { phase: "fix", round: 2, fixPasses: 3 });
    await tick();
    expect(app.lastFrame()).toContain("fixer · fix pass 2/3");
    events.emit("phase:change", { phase: "review", round: 2, fixPasses: 3 });
    await tick();
    expect(app.lastFrame()).toContain("review round 2");
    expect(app.lastFrame()).not.toContain("fix pass");
    events.emit("phase:change", { phase: "done" });
    await tick();
    expect(app.lastFrame()).toContain("✓ done");
  });

  it("shows the reviewer, tester and fixer states with retries, and focuses their output", async () => {
    const { events, app } = setup();
    events.emit("agent:start", { agent: "reviewer", label: "code-r0" });
    events.emit("agent:start", { agent: "tester", label: "tester-r0" });
    events.emit("agent:retry", {
      agent: "tester",
      label: "tester-r0",
      attempt: 2,
      attempts: 3,
      reason: { class: "invalid_report", message: "no report" },
    });
    events.emit("output", { label: "code-r0", text: "reviewing the diff\n" });
    events.emit("output", { label: "tester-r0", text: "booting the app\n" });
    await tick();
    let frame = app.lastFrame()!;
    expect(frame).toContain("retry 2/3");
    expect(frame).toContain("output of tester-r0");
    expect(frame).toContain("booting the app");

    app.stdin.write(ARROW_LEFT);
    await tick();
    expect(app.lastFrame()).toContain("output of code-r0");
    expect(app.lastFrame()).toContain("reviewing the diff");

    events.emit("agent:end", { agent: "reviewer", label: "code-r0", ok: true });
    events.emit("agent:end", { agent: "tester", label: "tester-r0", ok: true });
    events.emit("agent:start", { agent: "fixer", label: "fix-r1" });
    events.emit("agent:status", { agent: "fixer", status: "validating" });
    await tick();
    frame = app.lastFrame()!;
    expect(frame.match(/done/g)).toHaveLength(2);
    expect(frame).toContain("validating");

    events.emit("agent:end", { agent: "fixer", label: "fix-r1", ok: false });
    await tick();
    expect(app.lastFrame()).toContain("failed");
  });

  it("replaces the log tail with the final summary at the end of the run", async () => {
    const { events, app } = setup();
    events.emit("run:end", {
      runId: "20260101-000000-abcd",
      branch: "graph/20260101-000000-abcd",
      exitCode: 0,
      reports: [],
      fixPasses: 3,
      runDir: "/repo/.graph-execution/20260101-000000-abcd",
    });
    await tick();
    const frame = app.lastFrame()!;
    expect(frame).toContain("Run 20260101-000000-abcd finished");
    expect(frame).toContain("git merge --no-ff graph/20260101-000000-abcd");
    expect(frame).not.toContain("switch agent");
  });
});
