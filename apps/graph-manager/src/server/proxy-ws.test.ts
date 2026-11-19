import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "./app.js";
import { setSandboxLookup } from "./runs.js";
import { tempDir, testConfig } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
let gmPort: number;
let cookie: string;
let upstream: http.Server;
let wss: WebSocketServer;
let runDir: string;
/** Headers of every upgrade the fake upstream got. */
let seen: http.IncomingHttpHeaders[];
let urls: string[];

/** A run page server with a WebSocket echo at /echo; it checks Host like the engine does. */
function fakeUpstream(): http.Server {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.push(req.headers);
    urls.push(req.url ?? "");
    const { port } = server.address() as AddressInfo;
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === "127.0.0.1:7600";
    if (!hostOk || !req.url?.startsWith("/echo")) {
      socket.end("HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  return server;
}

beforeEach(async () => {
  seen = [];
  urls = [];
  ({ dir, cleanup } = await tempDir());
  const ws = path.join(dir, "ws", "github", "octo", "hello");
  await mkdir(ws, { recursive: true });
  await execa("git", ["init", "-q"], { cwd: ws });
  runDir = path.join(ws, ".graph-execution", "r1");
  await mkdir(runDir, { recursive: true });
  upstream = fakeUpstream();
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));

  app = await buildApp(testConfig(dir), { webDir: path.join(dir, "no-web"), viewCache: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  gmPort = (app.server.address() as AddressInfo).port;
  const login = await fetch(`http://127.0.0.1:${gmPort}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  setSandboxLookup(undefined);
  for (const c of wss.clients) c.terminate();
  wss.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await app.close();
  await cleanup();
});

const view = `/runs/github~octo~hello/r1/view`;

function connect(pathname: string, headers: Record<string, string>): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${gmPort}${pathname}`, { headers });
}

/** Opens, sends one message and resolves with the echo. */
function echo(ws: WebSocket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(text));
    ws.on("message", (data) => {
      resolve(data.toString());
      ws.close();
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`unexpected ${String(res.statusCode)}`)));
    ws.on("error", reject);
  });
}

/** The status the handshake was refused with, or "closed" if the socket closed without one. */
function refusal(ws: WebSocket): Promise<number | "closed"> {
  return new Promise((resolve, reject) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => reject(new Error("the WebSocket opened")));
    ws.on("error", () => resolve("closed"));
  });
}

describe("run page proxy: WebSocket upgrades", () => {
  it("passes a WebSocket through to the local run page, rewriting Host and dropping the cookie", async () => {
    const origin = `http://127.0.0.1:${gmPort}`;
    const ws = connect(`${view}/echo?x=1`, { cookie, origin, "x-graph-execution-token": "forged" });
    expect(await echo(ws, "hello")).toBe("hello");
    const { port } = upstream.address() as AddressInfo;
    expect(urls.at(-1)).toBe("/echo?x=1");
    expect(seen.at(-1)?.host).toBe(`127.0.0.1:${port}`);
    expect(seen.at(-1)?.cookie).toBeUndefined();
    expect(seen.at(-1)?.origin).toBeUndefined();
    expect(seen.at(-1)?.["x-graph-execution-token"]).toBeUndefined();
  });

  it("carries several messages both ways", async () => {
    const ws = connect(`${view}/echo`, { cookie });
    const got: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send("a");
        ws.send("b");
        ws.send("c");
      });
      ws.on("message", (d) => {
        got.push(d.toString());
        if (got.length === 3) resolve();
      });
      ws.on("error", reject);
    });
    ws.close();
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("injects the sandbox token and the hostPort Host for a sandboxed run", async () => {
    await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: "http://127.0.0.1:1/", pid: 2 ** 22 + 12345 }));
    const { port } = upstream.address() as AddressInfo;
    setSandboxLookup({
      pageOf: async () => ({ url: "http://127.0.0.1:7600/", pid: 0, upstream: { host: "127.0.0.1", port, hostPort: 7600, token: "tok" } }),
    });
    const ws = connect(`${view}/echo`, { cookie, "x-graph-execution-token": "forged" });
    expect(await echo(ws, "sandboxed")).toBe("sandboxed");
    expect(seen.at(-1)?.host).toBe("127.0.0.1:7600");
    expect(seen.at(-1)?.["x-graph-execution-token"]).toBe("tok");
  });

  it("answers 401 without a session cookie", async () => {
    expect(await refusal(connect(`${view}/echo`, {}))).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 403 for a foreign Origin, even with the cookie", async () => {
    expect(await refusal(connect(`${view}/echo`, { cookie, origin: "http://evil.example" }))).toBe(403);
    expect(seen).toEqual([]);
  });

  it("answers 404 when the run's page is not running", async () => {
    setSandboxLookup({ pageOf: async () => null });
    await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: "http://127.0.0.1:1/", pid: 2 ** 22 + 12345 }));
    expect(await refusal(connect(`${view}/echo`, { cookie }))).toBe(404);
  });

  it("passes the upstream's refusal through", async () => {
    expect(await refusal(connect(`${view}/nope`, { cookie }))).toBe(421);
  });

  it("answers 502 (or closes) when the upstream is down", async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const result = await refusal(connect(`${view}/echo`, { cookie }));
    expect([502, "closed"]).toContain(result);
    // afterEach closes it again.
    upstream = http.createServer();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });
});
