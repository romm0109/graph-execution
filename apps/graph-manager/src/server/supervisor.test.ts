import { existsSync } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { RunState } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGraphExecutionBin, type Config } from "./config.js";
import { RunOrigins } from "./run-origins.js";
import { DataStore } from "./store.js";
import { diffRun, eventLine, ORPHAN_ORIGIN_MS, RESUMING, reviewStepOf, RunEventWatcher, waitingFailedTask, type RunSnapshot } from "./supervisor.js";
import { TerminalManager } from "./terminals.js";
import { appWithLogin, tempDir, testConfig } from "./test-helpers.js";

const WS = "github~octo~hello";
const P = "[graph-manager] ";
const REPORT = "Supervisor: report. Tell the user what failed and why (get_run_log, get_node_output); do not change code or rerun.";
const ACT = "Supervisor: act. Find the cause with get_run_log and get_node_output, fix it, commit, then call resume_run with runId gm-1.";

describe("eventLine", () => {
  it("writes each event's exact line", () => {
    expect(eventLine({ kind: "started", runId: "gm-1", tasksDir: ".agents/tasks/x" }, "report")).toBe(`${P}Run gm-1 started (.agents/tasks/x).`);
    expect(eventLine({ kind: "review", runId: "gm-1" }, "report")).toBe(`${P}Run gm-1 entered review.`);
    expect(eventLine({ kind: "succeeded", runId: "gm-1", status: "applied" }, "report")).toBe(
      `${P}Run gm-1 succeeded (applied). Call get_artifacts to see what it wrote, open_run to show it.`,
    );
    expect(eventLine({ kind: "cancelled", runId: "gm-1" }, "act")).toBe(`${P}Run gm-1 was cancelled.`);
    expect(eventLine({ kind: "resumed", runId: "gm-1" }, "act")).toBe(`${P}Run gm-1 was resumed.`);
  });

  it("writes the failure line in report and act mode", () => {
    expect(eventLine({ kind: "failed", runId: "gm-1", failure: "task 3 failed" }, "report")).toBe(`${P}Run gm-1 failed: task 3 failed. ${REPORT}`);
    const act = eventLine({ kind: "failed", runId: "gm-1", failure: "task 3 failed" }, "act");
    expect(act).toBe(`${P}Run gm-1 failed: task 3 failed. ${ACT}`);
    expect(act).toContain("resume_run with runId gm-1");
  });

  it("cleans the failure text and fills in a missing one", () => {
    const ev = diffRun("gm-1", { status: "running" }, { type: "run", status: "failed", failure: "task 3\nfailed. " });
    expect(ev).toEqual([{ kind: "failed", runId: "gm-1", failure: "task 3 failed" }]);
    const line = eventLine(ev[0]!, "report");
    expect(line).not.toContain("\n");
    expect(line).toContain("failed: task 3 failed. Supervisor");
    expect(eventLine(diffRun("gm-1", { status: "running" }, { type: "run", status: "interrupted" })[0]!, "report")).toContain("failed: interrupted. ");
    expect(eventLine(diffRun("gm-1", { status: "running" }, { type: "run", status: "failed" })[0]!, "report")).toContain("failed: failed. ");
  });
});

describe("diffRun", () => {
  const run = (status: string, extra: Partial<RunSnapshot> = {}): RunSnapshot => ({ type: "run", status, ...extra });
  it("reports the first sight", () => {
    expect(diffRun("gm-1", undefined, run("running", { tasksDir: "d" }))).toEqual([{ kind: "started", runId: "gm-1", tasksDir: "d" }]);
    expect(diffRun("gm-1", undefined, run("applied", { tasksDir: "d", reviewStep: "review" }))).toEqual([
      { kind: "started", runId: "gm-1", tasksDir: "d" },
      { kind: "review", runId: "gm-1" },
      { kind: "succeeded", runId: "gm-1", status: "applied" },
    ]);
  });
  it("reports changes", () => {
    expect(diffRun("gm-1", { status: "running" }, run("running", { reviewStep: "validate" }))).toEqual([{ kind: "review", runId: "gm-1" }]);
    expect(diffRun("gm-1", { status: "running", reviewStep: "validate" }, run("running", { reviewStep: "review" }))).toEqual([]);
    expect(diffRun("gm-1", { status: "running" }, run("failed", { failure: "task 2 failed" }))).toEqual([{ kind: "failed", runId: "gm-1", failure: "task 2 failed" }]);
    expect(diffRun("gm-1", { status: "failed" }, run("running"))).toEqual([{ kind: "resumed", runId: "gm-1" }]);
    expect(diffRun("gm-1", { status: "failed" }, run("interrupted"))).toEqual([]);
    expect(diffRun("gm-1", { status: "running" }, run("aborted"))).toEqual([{ kind: "cancelled", runId: "gm-1" }]);
    expect(diffRun("gm-1", { status: "running" }, run("done"))).toEqual([{ kind: "succeeded", runId: "gm-1", status: "done" }]);
  });
});

describe("reviewStepOf", () => {
  const state = (tasks: Record<string, string>): RunState => ({ tasks: Object.fromEntries(Object.entries(tasks).map(([k, s]) => [k, { status: s }])), review: { phase: "review" } }) as unknown as RunState;
  it("is the review phase only once every task is merged", () => {
    expect(reviewStepOf(state({}))).toBeUndefined();
    expect(reviewStepOf(state({ "1": "merged", "2": "running" }))).toBeUndefined();
    expect(reviewStepOf(state({ "1": "merged", "2": "failed" }))).toBeUndefined();
    expect(reviewStepOf(state({ "1": "merged", "2": "merged" }))).toBe("review");
  });
});

describe("waitingFailedTask", () => {
  const state = (status: string, tasks: Record<string, string>): RunState =>
    ({ status, tasks: Object.fromEntries(Object.entries(tasks).map(([k, t]) => [k, { status: t }])), review: {} }) as unknown as RunState;
  it("is the failed task of a running run with nothing in flight", () => {
    expect(waitingFailedTask(state("running", { "1": "merged", "3": "failed", "4": "pending" }))).toBe("3");
    expect(waitingFailedTask(state("running", { "1": "running", "3": "failed" }))).toBeUndefined();
    expect(waitingFailedTask(state("running", { "1": "merged" }))).toBeUndefined();
    expect(waitingFailedTask(state("failed", { "3": "failed" }))).toBeUndefined();
  });
});

describe("diffRun after a resume", () => {
  it("reports resumed and the resumed attempt's end, even with the same end as before", () => {
    expect(diffRun("gm-1", { status: RESUMING }, { type: "run", status: "failed", failure: "x" })).toEqual([
      { kind: "resumed", runId: "gm-1" },
      { kind: "failed", runId: "gm-1", failure: "x" },
    ]);
    expect(diffRun("gm-1", { status: RESUMING }, { type: "run", status: "running" })).toEqual([{ kind: "resumed", runId: "gm-1" }]);
  });
});

describe("RunEventWatcher", () => {
  let cleanup: () => Promise<void>;
  let config: Config;
  let store: DataStore;
  let live: Set<string>;
  let typeWhenIdle: ReturnType<typeof vi.fn<(id: string, line: string) => boolean>>;
  let runOrigins: RunOrigins;
  let snaps: Map<string, RunSnapshot>;
  let snapshot: ReturnType<typeof vi.fn>;
  let watcher: RunEventWatcher;

  beforeEach(async () => {
    let dir: string;
    ({ dir, cleanup } = await tempDir());
    config = testConfig(dir);
    await mkdir(path.join(config.workspacesDir, "github", "octo", "hello", ".git"), { recursive: true });
    store = await DataStore.open(config.dataDir);
    live = new Set(["t1"]);
    typeWhenIdle = vi.fn<(id: string, line: string) => boolean>(() => true);
    const terminals = { get: (id: string) => (live.has(id) ? { id } : undefined), typeWhenIdle } as unknown as TerminalManager;
    runOrigins = new RunOrigins();
    snaps = new Map();
    snapshot = vi.fn(async () => snaps);
    watcher = new RunEventWatcher({ config, store, terminals, runOrigins }, { snapshot });
  });
  afterEach(async () => {
    await watcher.stop();
    await cleanup();
  });
  const lines = () => typeWhenIdle.mock.calls.map((c) => c[1]);

  it("does nothing without origins", async () => {
    await watcher.tick();
    expect(typeWhenIdle).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("types start, failure, resume and the act failure into the origin terminal", async () => {
    runOrigins.set(WS, "gm-1", "t1");
    snaps.set("gm-1", { type: "run", status: "running", tasksDir: ".agents/tasks/x" });
    await watcher.tick();
    expect(typeWhenIdle.mock.calls).toEqual([["t1", `${P}Run gm-1 started (.agents/tasks/x).`]]);
    await watcher.tick();
    expect(typeWhenIdle).toHaveBeenCalledTimes(1);
    snaps.set("gm-1", { type: "run", status: "failed", failure: "task 2 failed" });
    await watcher.tick();
    expect(lines()[1]).toBe(`${P}Run gm-1 failed: task 2 failed. ${REPORT}`);
    await store.update((d) => {
      d.workspaceSettings[WS] = { supervisor: "act" };
    });
    snaps.set("gm-1", { type: "run", status: "running" });
    await watcher.tick();
    snaps.set("gm-1", { type: "run", status: "failed", failure: "task 2 failed" });
    await watcher.tick();
    expect(lines().slice(2)).toEqual([`${P}Run gm-1 was resumed.`, `${P}Run gm-1 failed: task 2 failed. ${ACT}`]);
  });

  it("sends start then the end event for a run first seen already ended", async () => {
    runOrigins.set(WS, "gm-1", "t1");
    snaps.set("gm-1", { type: "run", status: "applied", tasksDir: "d" });
    await watcher.tick();
    expect(lines()).toEqual([`${P}Run gm-1 started (d).`, `${P}Run gm-1 succeeded (applied). Call get_artifacts to see what it wrote, open_run to show it.`]);
  });

  it("deletes an origin whose terminal is gone", async () => {
    runOrigins.set(WS, "gm-1", "t1");
    snaps.set("gm-1", { type: "run", status: "running" });
    live.delete("t1");
    await watcher.tick();
    expect(typeWhenIdle).not.toHaveBeenCalled();
    expect(runOrigins.entries()).toEqual([]);
  });

  it("drops suites and waits for runs that aren't there yet", async () => {
    runOrigins.set(WS, "suite-1", "t1");
    runOrigins.set(WS, "gm-2", "t1");
    runOrigins.set(WS, "gm-3", "t1");
    snaps.set("suite-1", { type: "suite", status: "running" });
    snaps.set("gm-3", { type: "run", status: "unknown" });
    await watcher.tick();
    expect(typeWhenIdle).not.toHaveBeenCalled();
    expect(runOrigins.entries().map((e) => e.runId).sort()).toEqual(["gm-2", "gm-3"]);
  });

  it("believes interrupted on the second tick", async () => {
    runOrigins.set(WS, "gm-1", "t1");
    snaps.set("gm-1", { type: "run", status: "running", tasksDir: "d" });
    await watcher.tick();
    snaps.set("gm-1", { type: "run", status: "interrupted" });
    await watcher.tick();
    expect(typeWhenIdle).toHaveBeenCalledTimes(1);
    await watcher.tick();
    expect(lines()[1]).toBe(`${P}Run gm-1 failed: interrupted. ${REPORT}`);
  });

  it("reports a resume that fails again before the next poll (F1)", async () => {
    runOrigins.set(WS, "gm-1", "t1");
    snaps.set("gm-1", { type: "run", status: "failed", failure: "task 2 failed", tasksDir: "d", stateMtimeMs: 1000 });
    await watcher.tick();
    expect(lines()).toHaveLength(2);
    const resumedAt = Date.now();
    runOrigins.set(WS, "gm-1", "t1", { resumedAt });
    // The resumed attempt hasn't written yet: the old failure is not reported again.
    await watcher.tick();
    expect(lines()).toHaveLength(2);
    snaps.set("gm-1", { type: "run", status: "failed", failure: "task 2 failed", stateMtimeMs: resumedAt + 500 });
    await watcher.tick();
    expect(lines().slice(2)).toEqual([`${P}Run gm-1 was resumed.`, `${P}Run gm-1 failed: task 2 failed. ${REPORT}`]);
    await watcher.tick();
    expect(lines()).toHaveLength(4);
  });

  it("reports resumed for a run first seen through a resume (F2)", async () => {
    runOrigins.set(WS, "gm-1", "t1", { resumedAt: Date.now() });
    snaps.set("gm-1", { type: "run", status: "running", tasksDir: "d" });
    await watcher.tick();
    expect(lines()).toEqual([`${P}Run gm-1 was resumed.`]);
  });

  it("reports a live run waiting on a failed task as failed, on the second sight (T1)", async () => {
    runOrigins.set(WS, "gm-1", "t1");
    snaps.set("gm-1", { type: "run", status: "running", tasksDir: "d" });
    await watcher.tick();
    snaps.set("gm-1", { type: "run", status: "failed", failure: "task 3 failed", waiting: true });
    await watcher.tick();
    expect(lines()).toHaveLength(1);
    await watcher.tick();
    expect(lines()[1]).toBe(`${P}Run gm-1 failed: task 3 failed. ${REPORT}`);
    // The user closes the page: the run ends failed, which is no second failure.
    snaps.set("gm-1", { type: "run", status: "failed", failure: "task 3 failed" });
    await watcher.tick();
    expect(lines()).toHaveLength(2);
  });

  it("drops an origin whose run never appears (F4)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      runOrigins.set(WS, "gm-9", "t1");
      await watcher.tick();
      expect(runOrigins.entries()).toHaveLength(1);
      vi.setSystemTime(Date.now() + ORPHAN_ORIGIN_MS + 1);
      await watcher.tick();
      expect(runOrigins.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes an origin of an unknown workspace", async () => {
    runOrigins.set("github~octo~missing", "gm-1", "t1");
    await watcher.tick();
    expect(runOrigins.entries()).toEqual([]);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("polls on a timer until stopped", async () => {
    const terminals = { get: () => ({ id: "t1" }), typeWhenIdle } as unknown as TerminalManager;
    const timed = new RunEventWatcher({ config, store, terminals, runOrigins }, { intervalMs: 20, snapshot });
    runOrigins.set(WS, "gm-1", "t1");
    timed.start();
    await new Promise((r) => setTimeout(r, 100));
    await timed.stop();
    const n = snapshot.mock.calls.length;
    expect(n).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(snapshot.mock.calls.length).toBe(n);
  });
});

const FIXTURES = fileURLToPath(new URL("../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);

describe("RunEventWatcher end to end", () => {
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    vi.restoreAllMocks();
  });

  it.skipIf(!built || process.platform === "win32")(
    "types started, review and succeeded into the terminal that started a fake run",
    async () => {
      const spy = vi.spyOn(TerminalManager.prototype, "typeWhenIdle").mockReturnValue(true);
      const origins = new RunOrigins();
      const c = await appWithLogin({ supervisorPollMs: 100, graphExecutionBin: BIN }, { runOrigins: origins });
      try {
        const wsDir = path.join(c.config.workspacesDir, "github", "octo", "hello");
        await mkdir(wsDir, { recursive: true });
        const git = (...args: string[]) => execa("git", args, { cwd: wsDir });
        await git("init", "-q", "-b", "main");
        await git("config", "user.name", "t");
        await git("config", "user.email", "t@example.com");
        await cp(path.join(FIXTURES, "diamond"), path.join(wsDir, "diamond"), { recursive: true });
        await cp(path.join(FIXTURES, "spec.md"), path.join(wsDir, "spec.md"));
        await git("add", ".");
        await git("commit", "-q", "-m", "init");

        const term = await c.app.inject({ method: "POST", url: "/api/terminals", headers: { cookie: c.cookie }, payload: { workspaceId: WS } });
        expect(term.statusCode).toBe(201);
        const terminalId = (term.json() as { id: string }).id;
        const res = await c.app.inject({
          method: "POST",
          url: `/api/runs/${WS}`,
          headers: { cookie: c.cookie },
          payload: { tasksDir: "diamond", spec: "spec.md", provider: "fake", originTerminalId: terminalId },
        });
        const created = res.json() as { runId: string; viewUrl: string; error?: string };
        expect(res.statusCode, created.error).toBe(201);
        const web = JSON.parse(await readFile(path.join(wsDir, ".graph-execution", created.runId, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
        if (web.pid) started.push(web.pid);

        const id = created.runId;
        const succeeded = `${P}Run ${id} succeeded (applied). Call get_artifacts to see what it wrote, open_run to show it.`;
        const runLines = () => spy.mock.calls.filter((call) => call[0] === terminalId && call[1].includes(`Run ${id} `)).map((call) => call[1]);
        const end = Date.now() + 90_000;
        while (!runLines().includes(succeeded)) {
          if (Date.now() > end) throw new Error(`timed out; lines: ${JSON.stringify(runLines())}`);
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(runLines()).toEqual([`${P}Run ${id} started (diamond).`, `${P}Run ${id} entered review.`, succeeded]);

        await c.app.inject({ method: "POST", url: `${created.viewUrl}close`, headers: { cookie: c.cookie } });
      } finally {
        await c.cleanup();
      }
    },
    120_000,
  );
});
