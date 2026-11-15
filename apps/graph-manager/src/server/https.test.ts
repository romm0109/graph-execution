// Test-only self-signed pair (openssl req -x509 ... -days 36500), never used outside tests.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { startInternalListener } from "./internal-listener.js";
import { tempDir, testConfig } from "./test-helpers.js";

const cert = readFileSync(new URL("./__fixtures__/tls/cert.pem", import.meta.url));
const key = readFileSync(new URL("./__fixtures__/tls/key.pem", import.meta.url));

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, opts: { method?: string; path: string; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        rejectUnauthorized: false,
        headers: opts.body === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let port: number;
let dir: string;

describe("graph-manager over HTTPS", () => {
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    app = await buildApp(testConfig(dir), { https: { cert, key }, webDir: path.join(dir, "no-web"), viewCache: false, internalToken: "tok" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("answers /healthz", async () => {
    const res = await request(port, { path: "/healthz" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("sets a Secure session cookie on login", async () => {
    const res = await request(port, { method: "POST", path: "/api/auth/login", body: JSON.stringify({ password: "pw" }) });
    expect(res.status).toBe(204);
    expect(String(res.headers["set-cookie"])).toContain("Secure");
  });

  it("does not answer plain HTTP on the TLS port", async () => {
    const status = await new Promise<number | "error">((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve("error"));
    });
    expect(status).not.toBe(200);
  });

});

describe.skipIf(process.platform === "win32")("terminals with TLS on", () => {
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    const config = testConfig(dir);
    await mkdir(config.workspacesDir, { recursive: true });
    app = await buildApp(config, { https: { cert, key }, webDir: path.join(dir, "no-web"), viewCache: false, internalToken: "tok" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("gets a plain-HTTP GM_INTERNAL_URL on another loopback port that serves only /api/internal/*", async () => {
    const res = await request(port, { method: "POST", path: "/api/auth/login", body: JSON.stringify({ password: "pw" }) });
    const cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    const made = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    expect(made.statusCode).toBe(201);
    const { id } = made.json() as { id: string };
    const ws = new WebSocket(`wss://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers: { cookie }, rejectUnauthorized: false });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
        if (msg.type === "data") out += msg.data ?? "";
        const m = /gmurl=\[(http[^\]]*)\]/.exec(out);
        if (m?.[1]) resolve(m[1]);
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "input", data: 'echo "gmurl=[$GM_INTERNAL_URL]"\r' })));
      ws.on("error", reject);
    });
    ws.close();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    expect(url).not.toBe(`http://127.0.0.1:${port}`);
    const tools = await fetch(`${url}/api/internal/tools`, { headers: { authorization: "Bearer tok" } });
    expect(tools.status).toBe(200);
    expect((await fetch(`${url}/healthz`)).status).toBe(404);
  });
});

describe("startInternalListener", () => {
  it("serves /api/internal/* over plain HTTP on loopback and 404s everything else", async () => {
    const bare = Fastify();
    bare.get("/api/internal/ping", async () => ({ ok: true }));
    bare.get("/other", async () => ({ other: true }));
    await bare.ready();
    const listener = await startInternalListener(bare);
    try {
      expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
      const ping = await fetch(`${listener.url}/api/internal/ping`);
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ ok: true });
      expect((await fetch(`${listener.url}/other`)).status).toBe(404);
    } finally {
      await listener.close();
      await bare.close();
    }
  });
});
