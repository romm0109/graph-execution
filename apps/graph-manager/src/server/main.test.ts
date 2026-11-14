import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import { browserUrl, startManager } from "./main.js";
import { tempDir } from "./test-helpers.js";

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

async function start(env: NodeJS.ProcessEnv): Promise<{ url: string; close(): Promise<void> }> {
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

    it("rejects only one of the two", async () => {
      await expect(startManager(envOf({ GM_TLS_CERT: certFile }))).rejects.toThrow("set both GM_TLS_CERT and GM_TLS_KEY, or neither");
    });
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
