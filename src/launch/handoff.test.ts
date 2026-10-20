import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handoff, planHandoff, tailLines, waitForReady } from "./handoff.js";
import type { DetachedStep, SpawnedChild } from "./handoff.js";

const all = () => true;
const none = () => false;
const ctx = { script: "/tmp/x/run.sh", id: "ab12" };

describe("planHandoff", () => {
  it("uses launchctl then a detached shell on macOS", () => {
    expect(planHandoff("darwin", ctx, all).steps).toEqual([
      { kind: "exec", commands: [["launchctl", ["submit", "-l", "graph-execution.ab12", "--", "/bin/sh", ctx.script]]] },
      { kind: "detached", command: "/bin/sh", args: [ctx.script] },
    ]);
  });

  it("uses systemd-run when present on Linux", () => {
    expect(planHandoff("linux", ctx, all).steps).toEqual([
      {
        kind: "exec",
        commands: [["systemd-run", ["--user", "--collect", "--unit", "graph-execution-ab12", "/bin/sh", ctx.script]]],
      },
      { kind: "detached", command: "/bin/sh", args: [ctx.script] },
    ]);
  });

  it("skips systemd-run when absent", () => {
    expect(planHandoff("linux", ctx, none).steps).toEqual([
      { kind: "detached", command: "/bin/sh", args: [ctx.script] },
    ]);
  });

  it("creates and runs a scheduled task on Windows", () => {
    const script = "C:\\Temp\\run.cmd";
    const plan = planHandoff("win32", { script, id: "ab12" }, all);
    expect(plan.taskName).toBe("graph-execution-ab12");
    expect(plan.steps).toEqual([
      {
        kind: "exec",
        commands: [
          ["schtasks", ["/create", "/tn", "graph-execution-ab12", "/sc", "once", "/st", "00:00", "/f", "/tr", `"${script}"`]],
          ["schtasks", ["/run", "/tn", "graph-execution-ab12"]],
        ],
        cleanup: ["schtasks", ["/delete", "/tn", "graph-execution-ab12", "/f"]],
      },
      { kind: "detached", command: "cmd", args: ["/c", script], windowsHide: true },
    ]);
  });

  it("skips the scheduled task when the path is too long", () => {
    const plan = planHandoff("win32", { script: "C:\\" + "a".repeat(300), id: "x" }, all);
    expect(plan.steps.map((s) => s.kind)).toEqual(["detached"]);
    expect(plan.taskName).toBeUndefined();
  });
});

function fakeSpawn(error?: Error) {
  const spawned: DetachedStep[] = [];
  const spawn = (step: DetachedStep): SpawnedChild => {
    spawned.push(step);
    const child = new EventEmitter();
    if (error) setTimeout(() => child.emit("error", error), 0);
    return Object.assign(child, { unref() {} });
  };
  return { spawned, spawn };
}

describe("handoff", () => {
  const plan = planHandoff("linux", ctx, all);

  it("stops at the first passing step", async () => {
    const calls: string[][] = [];
    const { spawned, spawn } = fakeSpawn();
    const result = await handoff(plan, {
      exec: async (c, a) => (calls.push([c, ...a]), 0),
      spawn,
    });
    expect(result).toEqual({ ok: true, step: 0 });
    expect(calls).toHaveLength(1);
    expect(spawned).toHaveLength(0);
  });

  it("falls through to the detached spawn when the OS command fails", async () => {
    const { spawned, spawn } = fakeSpawn();
    const result = await handoff(plan, { exec: async () => 1, spawn, settleMs: 10 });
    expect(result).toEqual({ ok: true, step: 1 });
    expect(spawned).toEqual([{ kind: "detached", command: "/bin/sh", args: [ctx.script] }]);
  });

  it("fails a Windows step when the second command fails", async () => {
    const win = planHandoff("win32", { script: "C:\\r.cmd", id: "a" }, all);
    const seen: string[] = [];
    const { spawn } = fakeSpawn();
    const result = await handoff(win, {
      exec: async (_c, a) => (seen.push(a[0] ?? ""), a[0] === "/run" ? 1 : 0),
      spawn,
      settleMs: 10,
    });
    expect(seen).toEqual(["/create", "/run"]);
    expect(result).toEqual({ ok: true, step: 1 });
  });

  it("reports blocked when every step fails", async () => {
    const { spawn } = fakeSpawn(new Error("spawn /bin/sh ENOENT"));
    const result = await handoff(plan, { exec: async () => 2, spawn, settleMs: 50 });
    expect(result).toEqual({ ok: false, reason: "/bin/sh: spawn /bin/sh ENOENT" });
  });
});

describe("waitForReady", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "handoff-test-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("returns the parsed ready file once written", async () => {
    const readyFile = path.join(dir, "ready.json");
    setTimeout(() => {
      void writeFile(readyFile, JSON.stringify({ url: "http://127.0.0.1:1/", runId: "r1", pid: 42 }));
    }, 50);
    const result = await waitForReady({ readyFile, pollMs: 10, readLogTail: async () => "" });
    expect(result).toEqual({ ok: true, url: "http://127.0.0.1:1/", runId: "r1", pid: 42 });
  });

  it("returns the last 20 log lines on timeout", async () => {
    const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const result = await waitForReady({
      readyFile: path.join(dir, "ready.json"),
      timeoutMs: 50,
      pollMs: 10,
      readLogTail: async () => log,
    });
    expect(result).toEqual({ ok: false, log: tailLines(log) });
    const lines = (result as { log: string }).log.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 11");
    expect(lines[19]).toBe("line 30");
  });

  it("ends early when the run process is dead", async () => {
    const started = Date.now();
    const result = await waitForReady({
      readyFile: path.join(dir, "ready.json"),
      timeoutMs: 10_000,
      pollMs: 10,
      isRunAlive: () => false,
      readLogTail: async () => "boom",
    });
    expect(result).toEqual({ ok: false, log: "boom" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
