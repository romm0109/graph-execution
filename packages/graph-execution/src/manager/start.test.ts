import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../launch/preflight.js";
import { applyManagerEnv, runManager, shouldOpen } from "./start.js";

describe("applyManagerEnv", () => {
  it("lets a flag override its variable", () => {
    const env: NodeJS.ProcessEnv = { GM_PORT: "1", GM_HOST: "a", GM_DATA_DIR: "/d", GM_WORKSPACES_DIR: "/w" };
    applyManagerEnv({ port: "9000", host: "0.0.0.0", dataDir: "/data", workspacesDir: "/ws" }, env, "/cli.js", false);
    expect(env).toEqual({ GM_PORT: "9000", GM_HOST: "0.0.0.0", GM_DATA_DIR: "/data", GM_WORKSPACES_DIR: "/ws", GM_GRAPH_EXECUTION_BIN: "/cli.js" });
  });

  it("keeps the variables of flags that were not given", () => {
    const env: NodeJS.ProcessEnv = { GM_PORT: "1", GM_HOST: "a", GM_DATA_DIR: "/d", GM_WORKSPACES_DIR: "/w" };
    applyManagerEnv({ open: false }, env, "/cli.js", false);
    expect(env).toEqual({ GM_PORT: "1", GM_HOST: "a", GM_DATA_DIR: "/d", GM_WORKSPACES_DIR: "/w", GM_GRAPH_EXECUTION_BIN: "/cli.js" });
    const empty: NodeJS.ProcessEnv = {};
    applyManagerEnv({}, empty, "/cli.js", false);
    expect(empty).toEqual({ GM_GRAPH_EXECUTION_BIN: "/cli.js" });
  });

  it("points the manager at this CLI unless GM_GRAPH_EXECUTION_BIN is set", () => {
    const set: NodeJS.ProcessEnv = { GM_GRAPH_EXECUTION_BIN: "/other/cli.js" };
    applyManagerEnv({}, set, "/cli.js", false);
    expect(set.GM_GRAPH_EXECUTION_BIN).toBe("/other/cli.js");
    const empty: NodeJS.ProcessEnv = { GM_GRAPH_EXECUTION_BIN: "" };
    applyManagerEnv({}, empty, "/cli.js", false);
    expect(empty.GM_GRAPH_EXECUTION_BIN).toBe("/cli.js");
  });

  it("deletes NODE_ENV only when the CLI defaulted it", () => {
    const defaulted: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    applyManagerEnv({}, defaulted, "/cli.js", true);
    expect("NODE_ENV" in defaulted).toBe(false);
    const explicit: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    applyManagerEnv({}, explicit, "/cli.js", false);
    expect(explicit.NODE_ENV).toBe("production");
  });
});

describe("shouldOpen", () => {
  it("opens in a terminal by default", () => {
    expect(shouldOpen(undefined, {}, true)).toBe(true);
    expect(shouldOpen(true, {}, true)).toBe(true);
    expect(shouldOpen(true, { GRAPH_EXECUTION_NO_OPEN: "0" }, true)).toBe(true);
  });

  it("does not open with --no-open, GRAPH_EXECUTION_NO_OPEN=1, without a terminal or over SSH", () => {
    expect(shouldOpen(false, {}, true)).toBe(false);
    expect(shouldOpen(true, { GRAPH_EXECUTION_NO_OPEN: "1" }, true)).toBe(false);
    expect(shouldOpen(true, {}, false)).toBe(false);
    expect(shouldOpen(true, { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, true)).toBe(false);
    expect(shouldOpen(true, { SSH_TTY: "/dev/pts/0" }, true)).toBe(false);
  });
});

describe("runManager", () => {
  interface Calls {
    started: NodeJS.ProcessEnv[];
    closed: number;
  }
  const calls = (): Calls => (globalThis as unknown as { __managerCalls: Calls }).__managerCalls;
  let dir: string;
  let n = 0;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ge-manager-"));
    (globalThis as unknown as { __managerCalls: Calls }).__managerCalls = { started: [], closed: 0 };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A stand-in for dist/manager/server/main.js; a new file each time, because imports are cached by URL. */
  function fakeMain(startBody: string): string {
    const file = path.join(dir, `main-${n++}.mjs`);
    writeFileSync(file, `export async function startManager(env) {\n  globalThis.__managerCalls.started.push({ ...env });\n  ${startBody}\n}\n`);
    return file;
  }
  const OK = `return { url: "http://127.0.0.1:4242", close: async () => { globalThis.__managerCalls.closed++; } };`;

  it("starts the manager with the flags, opens the browser, and closes it when stopped", async () => {
    const env: NodeJS.ProcessEnv = { GM_PORT: "1" };
    const open = vi.fn(async () => true);
    const code = await runManager({ port: "4242", dataDir: "/d" }, { mainFile: fakeMain(OK), cliPath: "/cli.js", env, isTTY: true, open, stopped: Promise.resolve() });
    expect(code).toBe(0);
    expect(calls().started).toHaveLength(1);
    expect(calls().started[0]).toMatchObject({ GM_PORT: "4242", GM_DATA_DIR: "/d", GM_GRAPH_EXECUTION_BIN: "/cli.js" });
    expect(calls().closed).toBe(1);
    expect(open).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:4242");
  });

  it("does not open the browser with --no-open or without a terminal, and survives a browser that fails", async () => {
    const open = vi.fn(async () => true);
    expect(await runManager({ open: false }, { mainFile: fakeMain(OK), env: {}, isTTY: true, open, stopped: Promise.resolve() })).toBe(0);
    expect(await runManager({}, { mainFile: fakeMain(OK), env: {}, isTTY: false, open, stopped: Promise.resolve() })).toBe(0);
    expect(open).not.toHaveBeenCalled();
    const failing = vi.fn(async () => Promise.reject(new Error("no browser")));
    expect(await runManager({}, { mainFile: fakeMain(OK), env: {}, isTTY: true, open: failing, stopped: Promise.resolve() })).toBe(0);
    expect(failing).toHaveBeenCalledOnce();
    expect(calls().closed).toBe(3);
  });

  it("stays up until it is stopped", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let done = false;
    const running = runManager({ open: false }, { mainFile: fakeMain(OK), env: {}, stopped }).then((code) => {
      done = true;
      return code;
    });
    await vi.waitFor(() => expect(calls().started).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(false);
    expect(calls().closed).toBe(0);
    stop();
    expect(await running).toBe(0);
    expect(calls().closed).toBe(1);
  });

  it("prints the error and returns 1 when the manager cannot start", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    const open = vi.fn(async () => true);
    const mainFile = fakeMain(`throw new Error("port 1 is already in use: pass --port or set GM_PORT");`);
    expect(await runManager({}, { mainFile, env: {}, isTTY: true, open, stopped: Promise.resolve() })).toBe(1);
    expect(errors).toEqual(["port 1 is already in use: pass --port or set GM_PORT"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a --port that is not a port number, naming the flag", async () => {
    for (const port of ["abc", "-1", "1.5", "70000", ""]) {
      const env: NodeJS.ProcessEnv = {};
      const starting = runManager({ port }, { mainFile: fakeMain(OK), env, stopped: Promise.resolve() });
      await expect(starting).rejects.toThrow(UsageError);
      await expect(starting).rejects.toThrow(`invalid --port "${port}": pass a number from 0 to 65535`);
      expect(env).toEqual({});
    }
  });

  it("refuses a build without graph-manager", async () => {
    const env: NodeJS.ProcessEnv = {};
    const starting = runManager({ port: "1" }, { mainFile: path.join(dir, "missing", "main.js"), env, stopped: Promise.resolve() });
    await expect(starting).rejects.toThrow(UsageError);
    await expect(starting).rejects.toThrow("graph-manager is not part of this build: run npm run build at the repository root");
    expect(env).toEqual({});
  });
});
