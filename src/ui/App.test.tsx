import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { App, formatElapsed } from "./App.js";
import { RunStore } from "./store.js";

const layers = [["1"], ["2", "3"], ["4"]];
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const events = new RunEmitter();
  const store = new RunStore(events, { taskIds: layers.flat(), attempts: 3 });
  const app = render(
    <App
      store={store}
      layers={layers}
      parents={{ "2": ["1"], "3": ["1"], "4": ["2", "3"] }}
      runId="20260101-000000-abcd"
      provider="fake"
      mergeTarget="main"
      logsDir="/repo/.graph-execution/r/logs"
      startedAt={Date.now()}
    />,
  );
  cleanup = app.unmount;
  return { events, store, app };
}

describe("App", () => {
  it("shows the header, every node of the diamond and the review nodes as pending", () => {
    const { app } = setup();
    const frame = app.lastFrame()!;
    expect(frame).toContain("run 20260101-000000-abcd");
    expect(frame).toContain("provider fake");
    // The arrows of the diamond: 1 fans out to 2 and 3, which fan in to 4.
    expect(frame).toMatch(/╭─+┴─+╮/);
    expect(frame).toMatch(/╰─+┬─+╯/);
    expect(frame.match(/▼/g)!.length).toBeGreaterThanOrEqual(8);
    expect(frame).toMatch(/tasks +━━ ◇ validate ━━ ◇ review ━━ ◇ fixer ━━ ◇ apply/);
    for (const id of ["1", "2", "3", "4"]) expect(frame).toContain(`─ ${id} ─`);
    for (const title of ["validate", "code reviewer", "live tester", "fixer", "apply → main"]) expect(frame).toContain(`─ ${title} ─`);
    expect(frame.match(/pending/g)).toHaveLength(9);
    expect(frame).toContain("0/4 tasks merged");
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
    expect(app.lastFrame()).toMatch(/◆ tasks ━━ +\S validate +━━ ◇ review/);
    events.emit("phase:change", { phase: "review", round: 0, fixPasses: 3 });
    await tick();
    expect(app.lastFrame()).toMatch(/◆ validate ━━ +\S review +━━ ◇ fixer/);
    events.emit("phase:change", { phase: "fix", round: 2, fixPasses: 3 });
    await tick();
    expect(app.lastFrame()).toContain("fixer · fix pass 2/3");
    events.emit("phase:change", { phase: "review", round: 2, fixPasses: 3 });
    await tick();
    expect(app.lastFrame()).toContain("review round 2");
    expect(app.lastFrame()).not.toContain("fix pass");
    events.emit("phase:change", { phase: "done" });
    events.emit("merge:status", { status: "running" });
    await tick();
    expect(app.lastFrame()).not.toContain("✓ done");
    expect(app.lastFrame()).toMatch(/\S apply /);
    events.emit("merge:status", { status: "done" });
    await tick();
    expect(app.lastFrame()).toContain("◆ apply");
    expect(app.lastFrame()).toContain("✓ done");
  });

  it("shows the reviewer, tester and fixer states with retries", async () => {
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
    await tick();
    expect(app.lastFrame()).toContain("retry 2/3");

    events.emit("agent:end", { agent: "reviewer", label: "code-r0", ok: true });
    events.emit("agent:end", { agent: "tester", label: "tester-r0", ok: true });
    events.emit("agent:start", { agent: "fixer", label: "fix-r1" });
    events.emit("agent:status", { agent: "fixer", status: "validating" });
    await tick();
    const frame = app.lastFrame()!;
    expect(frame.match(/✔ done/g)).toHaveLength(2);
    expect(frame).toContain("validating");

    events.emit("agent:end", { agent: "fixer", label: "fix-r1", ok: false });
    await tick();
    expect(app.lastFrame()).toContain("failed");
  });

  it("has no log panel, only where the logs are", () => {
    const { app } = setup();
    expect(app.lastFrame()).not.toContain("output of");
    expect(app.lastFrame()).toContain("agent logs → /repo/.graph-execution/r/logs");
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
    expect(frame).toContain("git merge --squash --no-commit graph/20260101-000000-abcd");
    expect(frame).not.toContain("agent logs →");
  });
});

describe("App at the end of a run", () => {
  it("shows the changes applied to the starting branch", async () => {
    const { events, app } = setup();
    events.emit("merge:status", { status: "done" });
    events.emit("run:end", {
      runId: "r",
      branch: "graph/r",
      exitCode: 0,
      reports: [],
      fixPasses: 3,
      runDir: "/repo/.graph-execution/r",
      merge: {
        target: "main",
        ok: true,
        files: [
          { path: "src/a.ts", added: 12, deleted: 3 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
        commits: ["abc1234 Add a", "def5678 Add b"],
      },
    });
    await tick();
    const frame = app.lastFrame()!;
    expect(frame).toContain("changes applied to main");
    expect(frame).toContain("Applied as uncommitted changes to main, nothing committed");
    expect(frame).toMatch(/\+12 -3 +src\/a\.ts/);
    expect(frame).toContain("2 file(s) changed, +13 -3");
    expect(frame).toContain("abc1234 Add a");
    expect(frame).toContain("git commit -a");
    expect(frame).toContain("git reset --hard");
    // The fixer never ran: it is shown as skipped, not pending.
    expect(frame).toContain("skipped");
  });
});

describe("App with more tasks than fit the terminal", () => {
  // A chain of 12 tasks: far taller than the 40 rows the test terminal is assumed to have.
  const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const chain = ids.map((id) => [id]);
  const parents = Object.fromEntries(ids.slice(1).map((id, i) => [id, [ids[i]!]]));

  function big() {
    const events = new RunEmitter();
    const store = new RunStore(events, { taskIds: ids, attempts: 3 });
    const app = render(
      <App store={store} layers={chain} parents={parents} runId="r" provider="fake" mergeTarget="main" startedAt={Date.now()} />,
    );
    cleanup = app.unmount;
    return { events, app };
  }

  it("shows a window of the graph and scrolls it with the keys and the mouse wheel", async () => {
    const { app } = big();
    const until = (check: (frame: string) => void) => vi.waitFor(() => check(app.lastFrame()!));
    await until((f) => expect(f).toContain("▲ top"));
    let frame = app.lastFrame()!;
    expect(frame).toContain("─ 1 ─");
    expect(frame).not.toContain("─ 12 ─");
    expect(frame.split("\n").length).toBeLessThan(40);

    app.stdin.write("G");
    await until((f) => expect(f).toContain("▼ end"));
    frame = app.lastFrame()!;
    expect(frame).toContain("apply → main");
    expect(frame).toContain("f to follow the running tasks");

    app.stdin.write("g");
    await until((f) => expect(f).toContain("▲ top"));
    // Wheel down: three lines per notch.
    app.stdin.write("\u001B[<65;10;10M");
    await until((f) => expect(f).toContain("▲ 3 above"));
    app.stdin.write("\u001B[<64;10;10M");
    await until((f) => expect(f).toContain("▲ top"));
  });

  it("follows the running task until the user scrolls, and again after f", async () => {
    const { events, app } = big();
    for (const id of ids.slice(0, 9)) events.emit("task:merged", { taskId: id, mergeCommit: "x" });
    events.emit("task:start", { taskId: "10" });
    const until = (check: (frame: string) => void) => vi.waitFor(() => check(app.lastFrame()!));
    await until((f) => expect(f).toMatch(/━ 10 ━/));
    expect(app.lastFrame()).toContain("following the running tasks");

    app.stdin.write("g");
    await until((f) => expect(f).not.toMatch(/━ 10 ━/));
    app.stdin.write("f");
    await until((f) => expect(f).toMatch(/━ 10 ━/));
  });

  it("writes the whole graph and the summary once the run is over", async () => {
    const { events, app } = big();
    events.emit("run:end", { runId: "r", branch: "graph/r", exitCode: 0, reports: [], fixPasses: 3, runDir: "/r" });
    await vi.waitFor(() => expect(app.frames.join("\n")).toContain("Run r finished"));
    const frame = app.frames.join("\n");
    for (const id of ids) expect(frame).toContain(`─ ${id} ─`);
    expect(frame).toContain("Run r finished");
  });
});
