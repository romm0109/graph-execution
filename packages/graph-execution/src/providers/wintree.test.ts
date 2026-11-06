import { describe, expect, it } from "vitest";
import { killLeftovers, leftoverDescendants, listProcessesArgs, parseProcessTable, type WinProcess } from "./wintree.js";

// Windows process tables, simulated: these run on every platform (GE-14).
const T = 1_000_000;
const p = (pid: number, ppid: number, created: number): WinProcess => ({ pid, ppid, created });

describe("leftoverDescendants", () => {
  it("finds the whole tree an exited agent left behind, through parent PIDs", () => {
    const procs = [p(4, 0, 0), p(10, 1, T - 60_000), p(200, 100, T + 1000), p(300, 200, T + 2000), p(301, 200, T + 2500), p(400, 300, T + 3000)];
    // Agent 100 ran from T to T+10s and is gone from the table.
    expect(leftoverDescendants(procs, 100, T, T + 10_000).sort()).toEqual([200, 300, 301, 400]);
  });

  it("leaves a process alone whose parent PID was reused before it was created", () => {
    // 200 is a leftover; 500 names 200 as parent but is older than it, so its parent was an earlier owner of PID 200.
    const procs = [p(200, 100, T + 1000), p(500, 200, T - 5000)];
    expect(leftoverDescendants(procs, 100, T, T + 10_000)).toEqual([200]);
  });

  it("ignores children of a reused agent PID that were created outside the agent's lifetime", () => {
    const procs = [p(200, 100, T - 60_000), p(201, 100, T + 60_000), p(202, 100, T + 5000)];
    expect(leftoverDescendants(procs, 100, T, T + 10_000)).toEqual([202]);
  });

  it("finds nothing when the agent left nothing", () => {
    expect(leftoverDescendants([p(4, 0, 0), p(50, 4, T)], 100, T, T + 1)).toEqual([]);
  });

  it("survives a ppid cycle and self-parented rows", () => {
    const procs = [p(200, 100, T + 1), p(300, 200, T + 2), p(200, 300, T + 3), p(0, 0, 0), p(7, 7, T + 1)];
    expect(leftoverDescendants(procs, 100, T, T + 10)).toEqual([200, 300]);
  });
});

describe("parseProcessTable", () => {
  it("reads PowerShell's `pid ppid createdMs` lines and skips anything else", () => {
    expect(parseProcessTable("0 0 0\r\n4 0 1700000000000\r\nWARNING: x\r\n\r\n812 4 1700000001234\r\n")).toEqual([
      p(0, 0, 0),
      p(4, 0, 1700000000000),
      p(812, 4, 1700000001234),
    ]);
  });
});

describe("listProcessesArgs", () => {
  it("sends the script base64-encoded as UTF-16LE, so no quoting reaches PowerShell's command line", () => {
    const args = listProcessesArgs();
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args[3]!, "base64").toString("utf16le");
    expect(script).toContain("Win32_Process");
    expect(script).toContain("ParentProcessId");
    expect(args[3]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("killLeftovers", () => {
  it("kills the leftovers in one call and reports them", async () => {
    const killed: number[][] = [];
    const pids = await killLeftovers(100, T, T + 10_000, {
      list: async () => [p(200, 100, T + 1), p(300, 200, T + 2), p(9, 1, T)],
      kill: async (ps) => void killed.push(ps),
    });
    expect(pids).toEqual([200, 300]);
    expect(killed).toEqual([[200, 300]]);
  });

  it("does not call taskkill when nothing is left, and never throws", async () => {
    let calls = 0;
    expect(await killLeftovers(100, T, T + 1, { list: async () => [], kill: async () => void calls++ })).toEqual([]);
    expect(calls).toBe(0);
    expect(await killLeftovers(100, T, T + 1, { list: () => Promise.reject(new Error("no powershell")) })).toEqual([]);
  });
});
