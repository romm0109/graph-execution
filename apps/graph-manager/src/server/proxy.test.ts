import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { upstreamPort } from "./proxy.js";
import { tempDir, testConfig } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
let base: string;
let cookie: string;
let upstream: http.Server;
let runDir: string;
/** Headers of every request the fake upstream got. */
let seen: http.IncomingHttpHeaders[];

/** The run page server's checks (Host, Origin on non-GET) and a few of its URLs. */
function fakeUpstream(): http.Server {
  return http.createServer((req, res) => {
    seen.push(req.headers);
    const { port } = upstream.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(421).end("bad host");
    if (req.method !== "GET" && req.headers.origin) return void res.writeHead(403).end("bad origin");
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>run page</title>");
    if (req.url === "/state") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runId: "r1" }));
    if (req.url === "/abort" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, body })));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: first\n\n");
      // Never ends on its own: the client must see the first event while the stream is open.
      return;
    }
    res.writeHead(404).end();
  });
}

beforeEach(async () => {
  seen = [];
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

  app = await buildApp(testConfig(dir), { webDir: path.join(dir, "no-web") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw" }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await app.close();
  await cleanup();
});

const view = `/runs/github~octo~hello/r1/view`;

describe("run page proxy", () => {
  it("redirects the view URL without its trailing slash", async () => {
    const res = await fetch(`${base}${view}?x=1`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${view}/?x=1`);
  });

  it("serves the page and its state with Host rewritten", async () => {
    const page = await fetch(`${base}${view}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("run page");
    const state = await fetch(`${base}${view}/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ runId: "r1" });
  });

  it("refuses a POST from a foreign Origin before it reaches the run page (F1)", async () => {
    const before = seen.length;
    const res = await fetch(`${base}${view}/abort`, { method: "POST", headers: { cookie, origin: "http://127.0.0.1:3000" }, body: "x" });
    expect(res.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it("strips Origin, Referer and the session cookie and streams the request body", async () => {
    const res = await fetch(`${base}${view}/abort`, {
      method: "POST",
      headers: { cookie, origin: new URL(base).origin, referer: `${base}/x`, "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: "hello" });
    const last = seen.at(-1)!;
    expect(last.cookie).toBeUndefined();
    expect(last.origin).toBeUndefined();
    expect(last.referer).toBeUndefined();
  });

  it("delivers the first SSE event before the upstream ends", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}${view}/events`, { headers: { cookie }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("data: first");
    ctrl.abort();
  });

  it("needs the login", async () => {
    const res = await fetch(`${base}${view}/state`);
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 404 when the run's page is not running", async () => {
    await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: "http://127.0.0.1:1/", pid: 2 ** 22 + 12345 }));
    const res = await fetch(`${base}${view}/state`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "the run's page is not running" });
  });

  it("answers 404 for an unknown run and 502 when the upstream is down", async () => {
    expect((await fetch(`${base}/runs/github~octo~hello/nope/view/`, { headers: { cookie } })).status).toBe(404);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const res = await fetch(`${base}${view}/state`, { headers: { cookie } });
    expect(res.status).toBe(502);
    upstream = fakeUpstream();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });

  it("only allows local upstreams", () => {
    expect(upstreamPort("http://127.0.0.1:8080/")).toBe(8080);
    expect(upstreamPort("http://localhost:9/")).toBe(9);
    expect(upstreamPort("http://example.com:80/")).toBeUndefined();
    expect(upstreamPort("https://127.0.0.1:8080/")).toBeUndefined();
  });
});
