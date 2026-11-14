import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createUser, disableUser, getUser, hashPassword } from "./accounts.js";
import { LOGIN_MAX_FAILURES, SESSION_COOKIE, needsAuth, needsSameOrigin, originAllowed, parseSession, signSession, verifySession } from "./auth.js";
import { openDb } from "./db/db.js";
import { signIdentity } from "./identity.js";
import { tempDir, testConfig } from "./test-helpers.js";

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let dir: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  const webDir = path.join(dir, "web");
  await mkdir(webDir, { recursive: true });
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>gm</title>");
  await writeFile(path.join(webDir, "app.js"), "console.log(1)");
  await writeFile(path.join(webDir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  app = await buildApp(testConfig(dir), { webDir, viewCache: false });
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

async function login(password = "pw") {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { password } });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return header.split(";")[0] ?? "";
}

describe("auth", () => {
  it("answers 401 on /api/health without a cookie", async () => {
    const res = await app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "login required" });
  });

  it("answers GET /api/auth/info with the host name without a cookie", async () => {
    const res = await app.inject({ url: "/api/auth/info" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ host: os.hostname(), mode: "users", signup: false });
    expect((await app.inject({ method: "POST", url: "/api/auth/info" })).statusCode).toBe(401);
  });

  it("answers /healthz without a cookie", async () => {
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(needsAuth("GET", "/healthz")).toBe(false);
  });

  it("serves /favicon.svg as an SVG without a cookie", async () => {
    const res = await app.inject({ url: "/favicon.svg" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^image\/svg\+xml/);
    expect(needsAuth("GET", "/favicon.svg")).toBe(false);
    const withCookie = await app.inject({ url: "/favicon.svg", headers: { cookie: cookieOf(await login()) } });
    expect(withCookie.statusCode).toBe(200);
    expect(String(withCookie.headers["content-type"])).toMatch(/^image\/svg\+xml/);
  });

  it("rejects a wrong password", async () => {
    const res = await login("nope");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "wrong username or password" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a body without a password with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("logs in, uses the session, and logs out", async () => {
    const res = await login();
    expect(res.statusCode).toBe(204);
    const header = String(res.headers["set-cookie"]);
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    const cookie = cookieOf(res);

    const health = await app.inject({ url: "/api/health", headers: { cookie } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie } })).json()).toEqual({ user: { id: "admin", name: "admin" }, mode: "users" });

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const cleared = String(out.headers["set-cookie"]);
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("revokes the session on logout, so a copied cookie stops working (T1)", async () => {
    const cookie = cookieOf(await login());
    const other = cookieOf(await login());
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/health", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/health", headers: { cookie: other } })).statusCode).toBe(200);
  });

  it("answers 429 after too many failed logins from one IP, even with the right password (F3)", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await login("nope")).statusCode).toBe(401);
    const locked = await login();
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(locked.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses state-changing requests from a foreign Origin (F1)", async () => {
    const cookie = cookieOf(await login());
    const foreign = { cookie, host: "127.0.0.1:7420", origin: "http://127.0.0.1:3000" };
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: foreign })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/runs/a/b/view/abort", headers: foreign })).statusCode).toBe(403);
    // Same origin, and no Origin at all (curl), still work; GETs are not checked.
    const own = { cookie, host: "127.0.0.1:7420", origin: "http://127.0.0.1:7420" };
    expect((await app.inject({ url: "/api/health", headers: foreign })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: own })).statusCode).toBe(204);
  });

  it("rejects a cookie with a changed HMAC", async () => {
    const cookie = cookieOf(await login());
    const last = cookie.at(-1) === "0" ? "1" : "0";
    const tampered = cookie.slice(0, -1) + last;
    expect((await app.inject({ url: "/api/health", headers: { cookie: tampered } })).statusCode).toBe(401);
  });

  it("guards the run-page proxy but serves other /runs paths as the SPA", async () => {
    expect((await app.inject({ url: "/runs/github~o~r/run1/view" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/runs/github~o~r/run1/view/api/state" })).statusCode).toBe(401);
    const spa = await app.inject({ url: "/runs/github~o~r/run1" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("<title>gm</title>");
    const deep = await app.inject({ url: "/settings" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    expect((await app.inject({ url: "/app.js" })).body).toBe("console.log(1)");
  });

  it("answers unknown /api routes with 404 when logged in", async () => {
    const cookie = cookieOf(await login());
    const res = await app.inject({ url: "/api/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("accounts login", () => {
  /** The app's db (the SQLite file in the data dir), for setting up users. */
  async function withDb<T>(fn: (db: Awaited<ReturnType<typeof openDb>>) => Promise<T>): Promise<T> {
    const db = await openDb(testConfig(dir));
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  }
  const loginAs = (username: string, password: string, remoteAddress?: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password }, ...(remoteAddress ? { remoteAddress } : {}) });

  it("logs in with a username and puts the user id in the cookie", async () => {
    const res = await loginAs("admin", "pw");
    expect(res.statusCode).toBe(204);
    const value = decodeURIComponent(cookieOf(res).slice(`${SESSION_COOKIE}=`.length));
    expect(value).toMatch(/^\d+\.[0-9a-f]{32}\.admin\.[0-9a-f]{64}$/);
    expect(parseSession(value, "nope")).toBeUndefined();
    // The username is normalized.
    expect((await loginAs(" Admin ", "pw")).statusCode).toBe(204);
  });

  it("answers 401 for an unknown user and 403 for a disabled one with the right password", async () => {
    expect((await loginAs("ghost", "pw")).json()).toEqual({ error: "wrong username or password" });
    await withDb(async (db) => {
      await createUser(db, { username: "bob", displayName: "Bob", passwordHash: await hashPassword("bob-secret-1") });
      await disableUser(db, "bob");
    });
    const res = await loginAs("bob", "bob-secret-1");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "account disabled" });
  });

  it("ends a disabled user's existing session at once", async () => {
    await withDb(async (db) => createUser(db, { username: "carol", displayName: "Carol", passwordHash: await hashPassword("carol-secret") }));
    const cookie = cookieOf(await loginAs("carol", "carol-secret"));
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie } });
    expect(me.json()).toEqual({ user: { id: "carol", name: "Carol" }, mode: "users" });
    await withDb((db) => disableUser(db, "carol"));
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("limits failed logins per username, across IPs, without locking out other users", async () => {
    await withDb(async (db) => createUser(db, { username: "alice", displayName: "alice", passwordHash: await hashPassword("alice-secret") }));
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await loginAs("alice", "nope", `10.0.0.${String(i + 1)}`)).statusCode).toBe(401);
    const locked = await loginAs("alice", "alice-secret", "10.0.1.1");
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(locked.json()).toEqual({ error: "too many failed logins; try again later" });
    expect((await loginAs("admin", "pw", "10.0.1.2")).statusCode).toBe(204);
  });

  it("rejects a cookie of the old 3-part format", async () => {
    const res = await loginAs("admin", "pw");
    const value = decodeURIComponent(cookieOf(res).slice(`${SESSION_COOKIE}=`.length));
    const [expires, nonce] = value.split(".");
    const old = `${SESSION_COOKIE}=${String(expires)}.${String(nonce)}.${"0".repeat(64)}`;
    expect((await app.inject({ url: "/api/health", headers: { cookie: old } })).statusCode).toBe(401);
  });
});

describe("needsAuth", () => {
  it.each([
    ["GET", "/api/health", true],
    ["GET", "/api/auth/me", true],
    ["POST", "/api/auth/logout", true],
    ["POST", "/api/auth/login", false],
    ["GET", "/api/auth/login", true],
    ["GET", "/api/auth/info", false],
    ["GET", "/api/auth/info?x=1", false],
    ["POST", "/api/auth/info", true],
    ["GET", "/api/auth/infos", true],
    ["POST", "/api/auth/login?x=1", false],
    ["POST", "/api/auth/signup", false],
    ["POST", "/api/auth/set-password", false],
    ["GET", "/api/account", true],
    ["PATCH", "/api/account", true],
    ["GET", "/api/terminals/1/ws", true],
    ["GET", "/runs/a/b/view", true],
    ["GET", "/runs/a/b/view/x/y", true],
    ["GET", "/runs/a/b/view?x", true],
    ["GET", "/runs/a/b", false],
    ["GET", "/runs/a/b/viewer", false],
    ["GET", "/runs", false],
    ["GET", "/settings", false],
    ["GET", "/", false],
  ])("%s %s → %s", (method, url, expected) => {
    expect(needsAuth(method, url)).toBe(expected);
  });
});

describe("origin checks", () => {
  it.each([
    ["GET", "/api/health", undefined, false],
    ["POST", "/api/terminals", undefined, true],
    ["DELETE", "/api/forges/github", undefined, true],
    ["POST", "/runs/a/b/view/abort", undefined, true],
    ["POST", "/runs/a/b", undefined, false],
    ["GET", "/api/terminals/t1/ws", "websocket", true],
  ])("needsSameOrigin %s %s (upgrade %s) → %s", (method, url, upgrade, expected) => {
    expect(needsSameOrigin(method, url, upgrade)).toBe(expected);
  });

  it("compares the Origin's host with Host or X-Forwarded-Host", () => {
    expect(originAllowed({ headers: {} })).toBe(true);
    expect(originAllowed({ headers: { host: "a:1", origin: "http://a:1" } })).toBe(true);
    expect(originAllowed({ headers: { host: "a:1", origin: "http://a:2" } })).toBe(false);
    expect(originAllowed({ headers: { host: "a:1", origin: "null" } })).toBe(false);
    expect(originAllowed({ headers: { host: "internal:7420", "x-forwarded-host": "gm.example.com", origin: "https://gm.example.com" } })).toBe(true);
  });
});

describe("verifySession", () => {
  it("accepts a fresh cookie and rejects an expired one or one signed with another secret", () => {
    const now = 1_000_000;
    const cookie = signSession("s", "admin", now);
    expect(verifySession(cookie, "s", now + 1)).toBe(true);
    expect(verifySession(cookie, "other", now + 1)).toBe(false);
    expect(verifySession(cookie, "s", now + 31 * 24 * 3600 * 1000)).toBe(false);
    expect(verifySession(undefined, "s", now)).toBe(false);
    expect(verifySession("garbage", "s", now)).toBe(false);
  });
});

describe("websocket upgrades", () => {
  it("go through the session hook", async () => {
    const { WebSocket } = await import("ws");
    app.get("/api/echo/ws", { websocket: true }, (socket) => {
      socket.send("hello");
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `ws://127.0.0.1:${port}/api/echo/ws`;

    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("opened without a session")));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(401);

    const cookie = cookieOf(await login());
    const msg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie } });
      ws.on("message", (d) => {
        resolve(String(d));
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(msg).toBe("hello");
  });
});

describe("gateway mode", () => {
  const SECRET = "g".repeat(40);
  const LOGOUT = "https://gw.example.com/logout";
  let gw: FastifyInstance;
  const uma = (name = "Uma"): Record<string, string> => ({ "x-gm-identity": signIdentity({ id: "u1", name }, SECRET) });

  beforeEach(async () => {
    gw = await buildApp(testConfig(path.join(dir, "gw"), { auth: "gateway", gatewaySecret: SECRET, gatewayLogoutUrl: LOGOUT, password: "" }), {
      webDir: path.join(dir, "web"),
      viewCache: false,
    });
  });
  afterEach(async () => {
    await gw.close();
  });

  it("answers 401 without a valid identity, and serves the user with one", async () => {
    const res = await gw.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "gateway identity required" });
    const wrong = signIdentity({ id: "u1", name: "Uma" }, "x".repeat(40));
    expect((await gw.inject({ url: "/api/health", headers: { "x-gm-identity": wrong } })).statusCode).toBe(401);
    expect((await gw.inject({ url: "/api/health", headers: uma() })).statusCode).toBe(200);
    const me = await gw.inject({ url: "/api/auth/me", headers: uma() });
    expect(me.json()).toEqual({ user: { id: "u1", name: "Uma" }, mode: "gateway", logoutUrl: LOGOUT });
  });

  it("ignores session cookies", async () => {
    await gw.inject({ url: "/api/health", headers: uma() });
    const cookie = `${SESSION_COOKIE}=${signSession(gw.ctx.store.instance().sessionSecret, "u1")}`;
    const res = await gw.inject({ url: "/api/health", headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "gateway identity required" });
  });

  it("guards the run-page proxy", async () => {
    expect((await gw.inject({ url: "/runs/x/y/view" })).statusCode).toBe(401);
    expect((await gw.inject({ url: "/runs/x/y/view/api/state" })).statusCode).toBe(401);
  });

  it("turns off the built-in sign-in routes", async () => {
    for (const url of ["/api/auth/login", "/api/auth/logout", "/api/auth/signup", "/api/auth/set-password"]) {
      const res = await gw.inject({ method: "POST", url, headers: uma(), payload: { username: "a", password: "pw", token: "t" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "not available in gateway mode" });
    }
    for (const method of ["GET", "PATCH"] as const) {
      const res = await gw.inject({ method, url: "/api/account", headers: uma(), payload: method === "PATCH" ? {} : undefined });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not available in gateway mode" });
    }
  });

  it("answers /api/auth/info with the mode and no sign-up", async () => {
    const res = await gw.inject({ url: "/api/auth/info" });
    expect(res.json()).toEqual({ host: os.hostname(), mode: "gateway", signup: false });
  });

  it("creates the user on the first request and keeps the name current", async () => {
    expect(await getUser(gw.ctx.db, "u1")).toBeUndefined();
    await gw.inject({ url: "/api/health", headers: uma() });
    expect(await getUser(gw.ctx.db, "u1")).toMatchObject({ id: "u1", displayName: "Uma", passwordHash: null, disabled: false });
    const me = await gw.inject({ url: "/api/auth/me", headers: uma("Uma B") });
    expect(me.json()).toMatchObject({ user: { id: "u1", name: "Uma B" } });
    expect((await getUser(gw.ctx.db, "u1"))?.displayName).toBe("Uma B");
  });

  it("refuses a built-in account and a disabled one", async () => {
    await createUser(gw.ctx.db, { id: "bob", username: "bob", displayName: "Bob", passwordHash: await hashPassword("pw-pw-pw-pw") });
    const bob = await gw.inject({ url: "/api/health", headers: { "x-gm-identity": signIdentity({ id: "bob", name: "Bob" }, SECRET) } });
    expect(bob.statusCode).toBe(403);
    expect(bob.json()).toEqual({ error: "this account uses built-in sign-in; gateway and built-in accounts cannot be mixed" });
    await gw.inject({ url: "/api/health", headers: uma() });
    await disableUser(gw.ctx.db, "u1");
    const res = await gw.inject({ url: "/api/health", headers: uma() });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "account disabled" });
  });

  it("keeps the Origin check", async () => {
    const res = await gw.inject({ method: "POST", url: "/api/auth/logout", headers: { ...uma(), origin: "http://evil.example" } });
    expect(res.statusCode).toBe(403);
  });

  it("checks WebSocket upgrades", async () => {
    const { WebSocket } = await import("ws");
    gw.get("/api/echo/ws", { websocket: true }, (socket) => {
      socket.send("hello");
    });
    await gw.listen({ port: 0, host: "127.0.0.1" });
    const addr = gw.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `ws://127.0.0.1:${port}/api/echo/ws`;
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("opened without an identity")));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(401);
    const msg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: uma() });
      ws.on("message", (d) => {
        resolve(String(d));
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(msg).toBe("hello");
  });
});
