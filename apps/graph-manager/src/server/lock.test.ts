import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireStartLock, answersAuthInfo, findRunning, LOCK_FILE, removeLock, START_FILE, type ServerLock, writeLock } from "./lock.js";
import { startManager } from "./main.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
  await cleanup();
});

const yes = { isAlive: () => true, answers: async () => true };
const lockOf = (extra: Partial<ServerLock> = {}): ServerLock => ({
  pid: process.pid + 100000,
  port: 7420,
  host: "127.0.0.1",
  startedAt: new Date().toISOString(),
  ...extra,
});
const writeRaw = (content: string): Promise<void> => writeFile(path.join(dir, LOCK_FILE), content);

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  if (pid === undefined) throw new Error("no pid");
  return pid;
}

describe("findRunning", () => {
  it("returns null without a lock file", async () => {
    expect(await findRunning(dir, yes)).toBeNull();
  });

  it("returns null for invalid JSON or an invalid lock", async () => {
    await writeRaw("{not json");
    expect(await findRunning(dir, yes)).toBeNull();
    await writeRaw(JSON.stringify({ pid: "x" }));
    expect(await findRunning(dir, yes)).toBeNull();
  });

  it("returns null for this process's own lock", async () => {
    await writeRaw(JSON.stringify(lockOf({ pid: process.pid })));
    expect(await findRunning(dir, yes)).toBeNull();
  });

  it("returns null when the pid is dead, or alive but the port does not answer", async () => {
    await writeRaw(JSON.stringify(lockOf()));
    expect(await findRunning(dir, { isAlive: () => false, answers: async () => true })).toBeNull();
    expect(await findRunning(dir, { isAlive: () => true, answers: async () => false })).toBeNull();
  });

  it("returns the lock when the pid is alive and the port answers", async () => {
    const lock = lockOf();
    await writeRaw(JSON.stringify(lock));
    expect(await findRunning(dir, yes)).toEqual(lock);
  });

  it("treats an exited pid as dead by default", async () => {
    await writeRaw(JSON.stringify(lockOf({ pid: await deadPid() })));
    expect(await findRunning(dir, { answers: async () => true })).toBeNull();
  });
});

describe("answersAuthInfo", () => {
  it("is true for a running graph-manager and false for a port without HTTP", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const manager = await startManager({
      GM_PORT: "0",
      GM_DATA_DIR: path.join(dir, "data"),
      GM_WORKSPACES_DIR: path.join(dir, "ws"),
      GM_DOCKER_SOCKET: path.join(dir, "none.sock"),
      GM_GRAPH_EXECUTION_BIN: "graph-execution",
      GM_PASSWORD: "pw",
    });
    closers.push(manager.close);
    expect(await answersAuthInfo("127.0.0.1", manager.port)).toBe(true);
    expect(await answersAuthInfo("0.0.0.0", manager.port)).toBe(true);

    // Accepts connections but never answers.
    const sockets: net.Socket[] = [];
    const holder = net.createServer((s) => sockets.push(s));
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          holder.close(() => resolve());
        }),
    );
    const started = Date.now();
    expect(await answersAuthInfo("127.0.0.1", (holder.address() as net.AddressInfo).port)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);
});

describe("writeLock / removeLock", () => {
  it("round-trips a lock, private on POSIX", async () => {
    const lock = lockOf();
    await writeLock(dir, lock);
    expect(await findRunning(dir, yes)).toEqual(lock);
    if (process.platform !== "win32") expect((await stat(path.join(dir, LOCK_FILE))).mode & 0o777).toBe(0o600);
  });

  it("removes only this process's lock", async () => {
    const file = path.join(dir, LOCK_FILE);
    await writeLock(dir, lockOf());
    await removeLock(dir);
    expect(existsSync(file)).toBe(true);
    await writeLock(dir, lockOf({ pid: process.pid }));
    await removeLock(dir);
    expect(existsSync(file)).toBe(false);
    await removeLock(dir); // no file: no throw
  });
});

describe("acquireStartLock", () => {
  const other = process.pid + 100000;

  it("creates the start file with this pid, and release removes it", async () => {
    const release = await acquireStartLock(dir);
    expect((await readFile(path.join(dir, START_FILE), "utf8")).trim()).toBe(String(process.pid));
    await release();
    expect(existsSync(path.join(dir, START_FILE))).toBe(false);
  });

  it("waits while another live process is starting, then takes the file", async () => {
    await writeFile(path.join(dir, START_FILE), String(other));
    let got = false;
    const p = acquireStartLock(dir, { isAlive: () => true, pollMs: 10 }).then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBe(false);
    await rm(path.join(dir, START_FILE));
    const release = await p;
    expect((await readFile(path.join(dir, START_FILE), "utf8")).trim()).toBe(String(process.pid));
    await release();
  });

  it("replaces the start file of a dead process at once", async () => {
    await writeFile(path.join(dir, START_FILE), String(other));
    const release = await acquireStartLock(dir, { isAlive: () => false, waitMs: 60_000 });
    expect((await readFile(path.join(dir, START_FILE), "utf8")).trim()).toBe(String(process.pid));
    await release();
  });

  it("takes over from a live process that never finishes its start", async () => {
    await writeFile(path.join(dir, START_FILE), String(other));
    const release = await acquireStartLock(dir, { isAlive: () => true, waitMs: 50, pollMs: 10 });
    expect((await readFile(path.join(dir, START_FILE), "utf8")).trim()).toBe(String(process.pid));
    await release();
  });

  it("release leaves another process's start file alone", async () => {
    const release = await acquireStartLock(dir);
    await writeFile(path.join(dir, START_FILE), String(other));
    await release();
    expect(existsSync(path.join(dir, START_FILE))).toBe(true);
  });
});
