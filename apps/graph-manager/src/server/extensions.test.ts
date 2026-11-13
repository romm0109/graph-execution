import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "./app.js";
import { tempDir, testConfig } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
let base: string;
let gmPort: number;
let cookie: string;
let upstream: http.Server;
let wss: WebSocketServer;
let upstreamPort: number;
/** Every HTTP request the fake extension got. */
let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders }[];
/** Every WebSocket upgrade the fake extension got. */
let wsSeen: { url?: string; headers: http.IncomingHttpHeaders }[];
const clients: WebSocket[] = [];

function fakeUpstream(): http.Server {
  return http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>demo ext</title>");
    if (req.url === "/echo" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end(`body:${body}`));
      return;
    }
    if (req.url === "/cookie") return void res.writeHead(200, { "set-cookie": "gm_session=evil; Path=/" }).end("c");
    if (req.url?.startsWith("/base/x")) return void res.writeHead(200).end("based");
    res.writeHead(404).end();
  });
}

async function startUpstream(port = 0): Promise<void> {
  upstream = fakeUpstream();
  wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    wsSeen.push({ url: req.url, headers: req.headers });
    ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => upstream.listen(port, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
}

async function stopUpstream(): Promise<void> {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}

beforeEach(async () => {
  seen = [];
  wsSeen = [];
  ({ dir, cleanup } = await tempDir());
  await startUpstream();
  const config = testConfig(dir, {
    extensions: [
      { name: "demo", url: `http://127.0.0.1:${upstreamPort}` },
      { name: "based", url: `http://127.0.0.1:${upstreamPort}/base` },
    ],
    extensionSecret: "s3cret",
  });
  app = await buildApp(config, { webDir: path.join(dir, "no-web"), viewCache: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  gmPort = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${gmPort}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw" }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await stopUpstream();
  await app.close();
  await cleanup();
});

function connect(pathname: string, headers: Record<string, string> = { cookie }): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${gmPort}${pathname}`, { headers });
  clients.push(ws);
  return ws;
}

function refusedStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.on("unexpected-response", (_req, r) => resolve(r.statusCode ?? 0));
    ws.on("open", () => reject(new Error("the upgrade was accepted")));
    ws.on("error", () => undefined);
  });
}

describe("extension slot", () => {
  it("lists the extension names only", async () => {
    const res = await fetch(`${base}/api/extensions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extensions: [{ name: "demo" }, { name: "based" }] });
  });

  it("lists no extensions without GM_EXTENSIONS", async () => {
    const plain = await buildApp(testConfig(dir), { webDir: path.join(dir, "no-web"), viewCache: false });
    try {
      const login = await plain.inject({ method: "POST", url: "/api/auth/login", payload: { password: "pw" } });
      const raw = login.headers["set-cookie"];
      const c = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(";")[0] ?? "";
      const res = await plain.inject({ url: "/api/extensions", headers: { cookie: c } });
      expect(res.json()).toEqual({ extensions: [] });
      const ext = await plain.inject({ url: "/ext/demo/", headers: { cookie: c } });
      expect(ext.statusCode).toBe(404);
      expect((await plain.inject({ url: "/ext/demo/" })).statusCode).toBe(401);
    } finally {
      await plain.close();
    }
  });

  it("serves the extension page with the secret and user headers and without the cookie", async () => {
    const res = await fetch(`${base}/ext/demo/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("demo ext");
    const h = seen.at(-1)!.headers;
    expect(h["x-gm-extension-secret"]).toBe("s3cret");
    expect(h["x-gm-user"]).toBe("admin");
    expect(h["x-forwarded-prefix"]).toBe("/ext/demo");
    expect(h.host).toBe(`127.0.0.1:${upstreamPort}`);
    expect(h.cookie).toBeUndefined();
  });

  it("replaces browser-sent extension headers", async () => {
    await fetch(`${base}/ext/demo/`, { headers: { cookie, "x-gm-extension-secret": "forged", "x-gm-user": "mallory" } });
    const h = seen.at(-1)!.headers;
    expect(h["x-gm-extension-secret"]).toBe("s3cret");
    expect(h["x-gm-user"]).toBe("admin");
  });

  it("redirects the extension URL without its trailing slash", async () => {
    const res = await fetch(`${base}/ext/demo?x=1`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ext/demo/?x=1");
  });

  it("keeps the base path of the extension URL", async () => {
    const res = await fetch(`${base}/ext/based/x?y=1`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("/base/x?y=1");
  });

  it.each(["/ext/based/../secret", "/ext/based/x/%2e%2e/%2E%2E/secret", "/ext/based/..%2Fsecret", "/ext/based/.%2e\\secret"])(
    "refuses the dot-segment path %s",
    async (raw) => {
      // A raw request: fetch would normalize the path before sending it.
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: gmPort, path: raw, headers: { cookie } }, (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          })
          .on("error", reject);
      });
      expect(status).toBe(400);
      expect(seen).toEqual([]);
    },
  );

  it("drops the extension's Set-Cookie", async () => {
    const res = await fetch(`${base}/ext/demo/cookie`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("streams a same-origin POST body and refuses a cross-origin one", async () => {
    const ok = await fetch(`${base}/ext/demo/echo`, { method: "POST", headers: { cookie, origin: base, "content-type": "text/plain" }, body: "hello" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("body:hello");
    const before = seen.length;
    const bad = await fetch(`${base}/ext/demo/echo`, { method: "POST", headers: { cookie, origin: "http://127.0.0.1:3000" }, body: "x" });
    expect(bad.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it("needs the login", async () => {
    const res = await fetch(`${base}/ext/demo/`);
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 404 for an unknown extension", async () => {
    const res = await fetch(`${base}/ext/nope/`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown extension" });
  });

  it("answers 502 when the extension is down", async () => {
    const port = upstreamPort;
    await stopUpstream();
    const res = await fetch(`${base}/ext/demo/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "the extension did not answer" });
    await startUpstream(port);
  });

  it("relays WebSocket messages both ways with the secret header", async () => {
    const ws = connect("/ext/demo/socket?a=1");
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });
    expect(reply).toBe("echo:hi");
    expect(wsSeen.at(-1)?.url).toBe("/socket?a=1");
    expect(wsSeen.at(-1)?.headers["x-gm-extension-secret"]).toBe("s3cret");
    expect(wsSeen.at(-1)?.headers["x-gm-user"]).toBe("admin");
    expect(wsSeen.at(-1)?.headers.cookie).toBeUndefined();
    ws.close();
  });

  it("closes the WebSocket when the extension is down or unknown", async () => {
    const unknown = connect("/ext/nope/socket");
    const code = await new Promise<number>((resolve) => unknown.on("close", (c) => resolve(c)));
    expect(code).toBe(4404);
    const port = upstreamPort;
    await stopUpstream();
    const down = connect("/ext/demo/socket");
    const downCode = await new Promise<number>((resolve) => down.on("close", (c) => resolve(c)));
    expect(downCode).toBe(1011);
    await startUpstream(port);
  });

  it("refuses a WebSocket upgrade without the login or from a foreign Origin", async () => {
    expect(await refusedStatus(connect("/ext/demo/socket", {}))).toBe(401);
    expect(await refusedStatus(connect("/ext/demo/socket", { cookie, origin: "http://127.0.0.1:3000" }))).toBe(403);
    expect(wsSeen).toEqual([]);
  });
});
