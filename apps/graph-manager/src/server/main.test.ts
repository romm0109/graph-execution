import { type ChildProcess, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlreadyRunningError, ConfigError } from "./config.js";
import { LOCK_FILE } from "./lock.js";
import { browserUrl, startManager } from "./main.js";
import { tempDir } from "./test-helpers.js";

/** The built entry the desktop app forks. */
const MAIN = fileURLToPath(new URL("../../dist/server/main.js", import.meta.url));

/** A live pid that is not this process: the vitest parent, alive for the whole test. */
const otherPid = process.ppid;

let dir: string;
let cleanup: () => Promise<void>;
let lines: string[];
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
  await cleanup();
});

/** Not absolute, so the skills sync stays out of the real ~/.claude/skills; the fake socket keeps Docker away. */
const envOf = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  GM_PORT: "0",
  GM_DATA_DIR: path.join(dir, "data"),
  GM_WORKSPACES_DIR: path.join(dir, "ws"),
  GM_DOCKER_SOCKET: path.join(dir, "none.sock"),
  GM_GRAPH_EXECUTION_BIN: "graph-execution",
  ...extra,
});

async function start(env: NodeJS.ProcessEnv): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const manager = await startManager(env);
  closers.push(manager.close);
  return manager;
}

const login = (url: string, password: string): Promise<Response> =>
  fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });

describe("browserUrl", () => {
  it("maps wildcard hosts to loopback and brackets IPv6 addresses", () => {
    expect(browserUrl("127.0.0.1", 7420)).toBe("http://127.0.0.1:7420");
    expect(browserUrl("localhost", 7420)).toBe("http://localhost:7420");
    expect(browserUrl("0.0.0.0", 7420)).toBe("http://127.0.0.1:7420");
    expect(browserUrl("::", 7420)).toBe("http://[::1]:7420");
    expect(browserUrl("fe80::1", 7420)).toBe("http://[fe80::1]:7420");
    expect(browserUrl("[::1]", 7420)).toBe("http://[::1]:7420");
    expect(browserUrl("0.0.0.0", 7420, "https")).toBe("https://127.0.0.1:7420");
  });
});

describe("startManager", () => {
  it("without GM_PASSWORD generates a password, prints it and keeps it for the next start", async () => {
    const file = path.join(dir, "data", "password");
    const { url, close } = await start(envOf());
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    expect(lines[0]).toBe(`graph-manager listening on ${url}`);
    const password = (await readFile(file, "utf8")).trim();
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(lines[1]).toBe(`Password: ${password} (saved in ${file})`);
    expect(lines).toHaveLength(2);

    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await login(url, password)).status).toBe(204);
    expect((await login(url, "nope")).status).toBe(401);

    await close();
    lines = [];
    await start(envOf());
    expect(lines[1]).toBe(`Password: ${password} (saved in ${file})`);
  });

  it("with GM_PASSWORD uses it, prints no password and writes no file", async () => {
    const { url } = await start(envOf({ GM_PASSWORD: "pw" }));
    expect(lines).toEqual([`graph-manager listening on ${url}`, "Password: from GM_PASSWORD"]);
    expect(lines.some((l) => /\bpw\b/.test(l))).toBe(false);
    expect(existsSync(path.join(dir, "data", "password"))).toBe(false);
    expect((await login(url, "pw")).status).toBe(204);
    expect((await login(url, "nope")).status).toBe(401);
  });

  it("rejects when the port is in use", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const port = (holder.address() as net.AddressInfo).port;
    const starting = startManager(envOf({ GM_PORT: String(port) }));
    await expect(starting).rejects.toThrow(ConfigError);
    await expect(starting).rejects.toThrow(`port ${port} is already in use: pass --port or set GM_PORT`);
    expect(lines).toEqual([]);
  });

  it("refuses a second server on the same data folder, and starts again after close", async () => {
    const lock = path.join(dir, "data", LOCK_FILE);
    const first = await start(envOf({ GM_PASSWORD: "pw" }));
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: process.pid, port: first.port, host: "127.0.0.1" });
    // The lock of this very process never blocks it: pretend it is another one.
    await writeFile(lock, JSON.stringify({ pid: otherPid, port: first.port, host: "127.0.0.1", startedAt: "x" }));
    lines = [];
    const second = startManager(envOf({ GM_PASSWORD: "pw" }));
    await expect(second).rejects.toBeInstanceOf(AlreadyRunningError);
    const err = (await second.catch((e: unknown) => e)) as AlreadyRunningError;
    expect(err.port).toBe(first.port);
    expect(err.pid).toBe(otherPid);
    expect(err.message).toBe(`graph-manager is already running on this data folder (pid ${otherPid}, http://127.0.0.1:${first.port})`);
    expect(lines).toEqual([]);

    await writeFile(lock, JSON.stringify({ pid: process.pid, port: first.port, host: "127.0.0.1", startedAt: "x" }));
    await first.close();
    expect(existsSync(lock)).toBe(false);
    const third = await start(envOf({ GM_PASSWORD: "pw" }));
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: process.pid, port: third.port });
  });

  it("is not blocked by the lock of a dead process", async () => {
    const lock = path.join(dir, "data", LOCK_FILE);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    await once(child, "exit");
    await mkdir(path.join(dir, "data"), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid, port: 1, host: "127.0.0.1", startedAt: "x" }));
    const { port } = await start(envOf({ GM_PASSWORD: "pw" }));
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: process.pid, port });
  });

  it("with GM_PORT_FALLBACK=1 listens on a free port when the port is in use", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const held = (holder.address() as net.AddressInfo).port;
    const { url, port } = await start(envOf({ GM_PORT: String(held), GM_PORT_FALLBACK: "1", GM_PASSWORD: "pw" }));
    expect(port).not.toBe(held);
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(lines).toEqual([`port ${held} is in use, using ${port}`, `graph-manager listening on ${url}`, "Password: from GM_PASSWORD"]);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it("rejects a bad variable with a ConfigError", async () => {
    await expect(startManager(envOf({ GM_PORT: "abc" }))).rejects.toThrow(ConfigError);
  });

  describe("with TLS", () => {
    // Test-only self-signed pair (openssl req -x509 ... -days 36500), never used outside tests.
    const certFile = fileURLToPath(new URL("./__fixtures__/tls/cert.pem", import.meta.url));
    const keyFile = fileURLToPath(new URL("./__fixtures__/tls/key.pem", import.meta.url));

    const healthz = (url: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const u = new URL(`${url}/healthz`);
        https
          .get({ host: u.hostname, port: u.port, path: u.pathname, rejectUnauthorized: false }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", reject);
      });

    it("serves HTTPS and prints an https:// URL", async () => {
      const { url } = await start(envOf({ GM_PASSWORD: "pw", GM_TLS_CERT: certFile, GM_TLS_KEY: keyFile }));
      expect(url).toMatch(/^https:\/\/127\.0\.0\.1:[1-9]\d*$/);
      expect(lines[0]).toBe(`graph-manager listening on ${url}`);
      expect(await healthz(url)).toBe(200);
    });

    it("rejects a certificate or key that can't be read", async () => {
      const missing = path.join(dir, "missing.pem");
      const noCert = startManager(envOf({ GM_PASSWORD: "pw", GM_TLS_CERT: missing, GM_TLS_KEY: keyFile }));
      await expect(noCert).rejects.toThrow(ConfigError);
      await expect(noCert).rejects.toThrow(new RegExp(`^cannot read TLS certificate ${escape(missing)}: `));
      const noKey = startManager(envOf({ GM_PASSWORD: "pw", GM_TLS_CERT: certFile, GM_TLS_KEY: missing }));
      await expect(noKey).rejects.toThrow(ConfigError);
      await expect(noKey).rejects.toThrow(new RegExp(`^cannot read TLS key ${escape(missing)}: `));
    });

    it("rejects a file that is not a PEM certificate", async () => {
      const starting = startManager(envOf({ GM_PASSWORD: "pw", GM_TLS_CERT: keyFile, GM_TLS_KEY: keyFile }));
      await expect(starting).rejects.toThrow(/^invalid TLS certificate or key: /);
    });

    it("writes https into server.lock, and a second server on the same data folder is refused", async () => {
      const tlsEnv = { GM_PASSWORD: "pw", GM_TLS_CERT: certFile, GM_TLS_KEY: keyFile };
      const lock = path.join(dir, "data", LOCK_FILE);
      const first = await start(envOf(tlsEnv));
      const written = JSON.parse(await readFile(lock, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ pid: process.pid, port: first.port, scheme: "https" });
      // The lock of this very process never blocks it: pretend it is another one. The probe then has to reach an
      // HTTPS server with a self-signed certificate, or it would count the lock as stale.
      await writeFile(lock, JSON.stringify({ ...written, pid: otherPid }));
      const second = startManager(envOf(tlsEnv));
      await expect(second).rejects.toBeInstanceOf(AlreadyRunningError);
      const err = (await second.catch((e: unknown) => e)) as AlreadyRunningError;
      expect(err.scheme).toBe("https");
      expect(err.port).toBe(first.port);
      expect(err.message).toBe(`graph-manager is already running on this data folder (pid ${otherPid}, https://127.0.0.1:${first.port})`);
      await writeFile(lock, JSON.stringify(written));
    });

    it("rejects only one of the two", async () => {
      await expect(startManager(envOf({ GM_TLS_CERT: certFile }))).rejects.toThrow("set both GM_TLS_CERT and GM_TLS_KEY, or neither");
    });
  });
});

describe("dist/server/main.js", () => {
  /** Forks the built entry with an IPC channel; the child is stopped after the test. */
  function forkMain(extra: Record<string, string> = {}): { child: ChildProcess; stderr: () => string } {
    // Fails rather than skips, so CI cannot pass without running it.
    if (!existsSync(MAIN)) throw new Error("build graph-manager first: npm run build -w graph-manager");
    const child = fork(MAIN, [], {
      env: { ...process.env, ...envOf({ GM_PASSWORD: "pw", GM_HOST: "127.0.0.1", ...extra }) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    closers.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const gone = once(child, "exit");
        child.kill();
        await gone;
      }
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdout?.resume();
    return { child, stderr: () => stderr };
  }

  const firstMessage = (child: ChildProcess, stderr: () => string): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      child.once("message", resolve);
      child.once("exit", (code) => reject(new Error(`main.js exited ${String(code)} before a message: ${stderr()}`)));
    });

  it(
    "sends { type: \"listening\", port } over IPC when forked",
    async () => {
      const { child, stderr } = forkMain();
      const message = await firstMessage(child, stderr);
      expect(message).toEqual({ type: "listening", port: expect.any(Number) });
      const port = (message as { port: number }).port;
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    },
    30_000,
  );

  it(
    "a second fork on the same data folder sends already-running and exits 3; shutdown over IPC removes the lock",
    async () => {
      const first = forkMain();
      const listening = (await firstMessage(first.child, first.stderr)) as { type: string; port: number };
      expect(listening.type).toBe("listening");

      const second = forkMain();
      const exited = once(second.child, "exit");
      const message = await firstMessage(second.child, second.stderr);
      expect(message).toEqual({ type: "already-running", port: listening.port, pid: first.child.pid, scheme: "http" });
      expect((await exited)[0]).toBe(3);

      const gone = once(first.child, "exit");
      first.child.send({ type: "shutdown" });
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no exit within 10 s")), 10_000));
      const [code] = await Promise.race([gone, timeout]);
      expect(code).toBe(0);
      expect(existsSync(path.join(dir, "data", LOCK_FILE))).toBe(false);
    },
    60_000,
  );
});
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
