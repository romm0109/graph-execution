import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { pidsDir, processStartTime, reapOrphans, recordProcess, trackProcesses } from "./processes.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

describe.skipIf(process.platform === "win32")("process registry", () => {
  let dir: string;
  const children: ChildProcess[] = [];
  const extraPids: number[] = [];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ge-processes-")));
  });
  afterEach(async () => {
    for (const c of children.splice(0)) {
      try {
        process.kill(-c.pid!, "SIGKILL");
      } catch {
        // gone
      }
    }
    for (const pid of extraPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** A process leading its own group, like an agent. */
  function spawnGroupLeader(code = "setInterval(() => {}, 1 << 30)"): ChildProcess {
    const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    return child;
  }

  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;
  const record = (pid: number, owner: number, start = processStartTime(pid), host?: string, sandbox = host !== undefined): void =>
    recordProcess(dir, {
      pid,
      pgid: pid,
      start,
      command: process.execPath,
      label: "1",
      role: "task",
      owner,
      ...(host !== undefined ? { host } : {}),
      ...(sandbox ? { sandbox: true } : {}),
    });
  const recordPath = (pid: number): string => path.join(pidsDir(dir), `${pid}.json`);

  it("kills the group of a record whose owner is dead and removes the record", async () => {
    const child = spawnGroupLeader();
    const exited = once(child, "exit");
    record(child.pid!, deadPid());
    const lines: string[] = [];
    const reaped = await reapOrphans(dir, { graceMs: 500, log: (l) => lines.push(l) });
    expect(reaped.map((r) => r.label)).toEqual(["1"]);
    expect((await exited)[1]).toBe("SIGTERM");
    expect(existsSync(recordPath(child.pid!))).toBe(false);
    expect(lines).toEqual([
      `stopped agent 1 (pid ${child.pid}) left running by an earlier graph-execution process`,
    ]);
  });

  it("kills a grandchild in the agent's group too", async () => {
    const child = spawnGroupLeader(
      `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });` +
        ` console.log(c.pid); setInterval(() => {}, 1 << 30);`,
    );
    const [line] = (await once(child.stdout!, "data")) as [Buffer];
    const grandPid = Number(line.toString().trim());
    extraPids.push(grandPid);
    expect(alive(grandPid)).toBe(true);
    record(child.pid!, deadPid());
    await reapOrphans(dir, { graceMs: 500 });
    expect(await waitGone(grandPid)).toBe(true);
  });

  it("leaves records of a live owner alone", async () => {
    const child = spawnGroupLeader();
    record(child.pid!, process.pid);
    expect(await reapOrphans(dir, { graceMs: 100 })).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
    expect(existsSync(recordPath(child.pid!))).toBe(true);
  });

  it("never kills a pid whose start time changed, and drops its record", async () => {
    const child = spawnGroupLeader();
    record(child.pid!, deadPid(), "not-the-real-start");
    expect(await reapOrphans(dir, { graceMs: 100 })).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
    expect(existsSync(recordPath(child.pid!))).toBe(false);
  });

  it("never kills an unmarked record of another host (KAN-88)", async () => {
    const child = spawnGroupLeader();
    record(child.pid!, deadPid(), undefined, "other-host", false);
    expect(await reapOrphans(dir, { graceMs: 100 })).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
    expect(existsSync(recordPath(child.pid!))).toBe(true);
  });

  describe("sandbox records of another host", () => {
    const TAKE = "GRAPH_EXECUTION_TAKE_LOCK_FROM";
    afterEach(() => {
      delete process.env[TAKE];
    });

    it("never kills the agents of another host", async () => {
      const child = spawnGroupLeader();
      record(child.pid!, deadPid(), undefined, "other-host");
      expect(await reapOrphans(dir, { graceMs: 100 })).toEqual([]);
      expect(alive(child.pid!)).toBe(true);
      expect(existsSync(recordPath(child.pid!))).toBe(true);
    });

    it("TAKE_LOCK_FROM drops another host's records without signals", async () => {
      const child = spawnGroupLeader();
      record(child.pid!, deadPid(), undefined, "other-host");
      process.env[TAKE] = "other-host";
      expect(await reapOrphans(dir, { graceMs: 100 })).toEqual([]);
      expect(alive(child.pid!)).toBe(true);
      expect(existsSync(recordPath(child.pid!))).toBe(false);
    });

    it("a record of this host (host field set) is reaped as before", async () => {
      const child = spawnGroupLeader();
      const exited = once(child, "exit");
      record(child.pid!, deadPid(), undefined, os.hostname());
      expect((await reapOrphans(dir, { graceMs: 500 })).map((r) => r.label)).toEqual(["1"]);
      expect((await exited)[1]).toBe("SIGTERM");
      expect(existsSync(recordPath(child.pid!))).toBe(false);
    });
  });

  it("drops the record of a process that is already gone", async () => {
    const pid = deadPid();
    record(pid, deadPid(), "whatever");
    expect(await reapOrphans(dir)).toEqual([]);
    expect(existsSync(recordPath(pid))).toBe(false);
  });

  it("ignores unreadable records and a missing pids folder", async () => {
    expect(await reapOrphans(dir)).toEqual([]);
  });

  it("trackProcesses records an agent while it runs and forgets it once it exits", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "ge-processes-cwd-")));
    try {
      const ac = new AbortController();
      let seen: Record<string, unknown> | undefined;
      const fake = createFakeProvider(fakeScriptSchema.parse({ "task:1": { attempts: [{ hang: true }] } }), {
        onSpawn: (pid) => {
          const file = recordPath(pid);
          expect(existsSync(file)).toBe(true);
          seen = JSON.parse(readFileSync(file, "utf8"));
          expect(seen).toMatchObject({ pid, pgid: pid, owner: process.pid, label: "1", role: "task", host: os.hostname() });
          ac.abort();
        },
      });
      const run = trackProcesses(fake, dir).run({ role: "task", prompt: "", cwd, signal: ac.signal, label: "1" });
      for await (const _ of run.events) void _;
      await run.done;
      expect(seen).toBeDefined();
      expect(existsSync(recordPath(seen!.pid as number))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
