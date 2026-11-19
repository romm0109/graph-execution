import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { requireScope } from "../auth.js";
import { DATA_FILE, type DataStore } from "../store.js";
import { appWithLogin, cookieOf, tempDir, testConfig } from "../test-helpers.js";

const bearer = (t: string) => ({ authorization: "Bearer " + t });

describe("API tokens", () => {
  let app: FastifyInstance;
  let cookie: string;
  let store: DataStore;
  let dataDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const env = await appWithLogin();
    ({ app, cookie, store, cleanup } = env);
    dataDir = env.config.dataDir;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
  });

  const create = async (scopes: string[] = ["runs:read"], name = "ci") => {
    const res = await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload: { name, scopes } });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; token: string; name: string; scopes: string[]; createdAt: string; createdBy: string }>();
  };

  it("creates a token shown once, lists it without the token or hash, and stores only the hash", async () => {
    const created = await create(["runs:read", "runs:read", "workspaces:read"]);
    expect(created.token).toMatch(/^gmt_[A-Za-z0-9_-]{43}$/);
    expect(created.scopes).toEqual(["runs:read", "workspaces:read"]);
    expect(created.createdBy).toBe("admin");
    const hash = store.get().apiTokens[created.id]?.hash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const list = await app.inject({ method: "GET", url: "/api/tokens", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      tokens: [{ id: created.id, name: "ci", scopes: ["runs:read", "workspaces:read"], createdAt: created.createdAt, createdBy: "admin" }],
    });
    expect(list.body).not.toContain(created.token);
    expect(list.body).not.toContain(hash);

    const file = await readFile(path.join(dataDir, DATA_FILE), "utf8");
    expect(file).toContain(hash);
    expect(file).not.toContain(created.token);
  });

  it("lists tokens newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await create(["runs:read"], "old");
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    await create(["runs:read"], "new");
    const list = await app.inject({ method: "GET", url: "/api/tokens", headers: { cookie } });
    expect(list.json<{ tokens: { name: string }[] }>().tokens.map((t) => t.name)).toEqual(["new", "old"]);
  });

  it("authenticates /api/v1/ping with a token or the cookie, and refuses anything else", async () => {
    const { token } = await create();
    const ok = await app.inject({ method: "GET", url: "/api/v1/ping", headers: bearer(token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/ping", headers: { authorization: "bearer " + token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/ping" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/ping", headers: { cookie } })).json()).toEqual({ ok: true });
    const bad = await app.inject({ method: "GET", url: "/api/v1/ping", headers: bearer("gmt_nope") });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "invalid token" });
    const notGmt = await app.inject({ method: "GET", url: "/api/v1/ping", headers: { ...bearer("xyz"), cookie } });
    expect(notGmt.json()).toEqual({ error: "invalid token" });
    // A non-Bearer Authorization header is no token: the cookie decides.
    expect((await app.inject({ method: "GET", url: "/api/v1/ping", headers: { authorization: "Basic abc", cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/ping", headers: { authorization: "Basic abc" } })).json()).toEqual({
      error: "login required",
    });
  });

  it("revokes a token: 204, then 401 invalid token, then 404 on a second delete", async () => {
    const { id, token } = await create();
    const del = await app.inject({ method: "DELETE", url: `/api/tokens/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/api/v1/ping", headers: bearer(token) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "invalid token" });
    const again = await app.inject({ method: "DELETE", url: `/api/tokens/${id}`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "unknown token" });
  });

  it("ignores a bearer token outside /api/v1", async () => {
    const { token } = await create(["runs:read", "workspaces:read"]);
    for (const url of ["/api/workspaces", "/api/tokens"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(token) });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "login required" });
    }
    const post = await app.inject({ method: "POST", url: "/api/tokens", headers: bearer(token), payload: { name: "x", scopes: ["runs:read"] } });
    expect(post.statusCode).toBe(401);
  });

  it("skips the Origin check for a bearer request to /api/v1 but not for a cookie request", async () => {
    const { token } = await create();
    const viaToken = await app.inject({ method: "POST", url: "/api/v1/ping", headers: { ...bearer(token), origin: "http://evil.example" } });
    expect(viaToken.statusCode).toBe(404);
    const viaCookie = await app.inject({ method: "POST", url: "/api/v1/ping", headers: { cookie, origin: "http://evil.example" } });
    expect(viaCookie.statusCode).toBe(403);
    expect(viaCookie.json()).toEqual({ error: "cross-origin request refused" });
  });

  it("writes lastUsedAt at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const { id, token } = await create();
    expect(store.get().apiTokens[id]?.lastUsedAt).toBeUndefined();
    await app.inject({ method: "GET", url: "/api/v1/ping", headers: bearer(token) });
    await vi.waitFor(() => expect(store.get().apiTokens[id]?.lastUsedAt).toBe("2026-03-01T10:00:00.000Z"));
    vi.setSystemTime(new Date("2026-03-01T10:00:30Z"));
    await Promise.all([1, 2, 3].map(() => app.inject({ method: "GET", url: "/api/v1/ping", headers: bearer(token) })));
    await store.update(() => undefined); // waits for any queued write
    expect(store.get().apiTokens[id]?.lastUsedAt).toBe("2026-03-01T10:00:00.000Z");
    vi.setSystemTime(new Date("2026-03-01T10:01:01Z"));
    await app.inject({ method: "GET", url: "/api/v1/ping", headers: bearer(token) });
    await vi.waitFor(() => expect(store.get().apiTokens[id]?.lastUsedAt).toBe("2026-03-01T10:01:01.000Z"));
    const list = await app.inject({ method: "GET", url: "/api/tokens", headers: { cookie } });
    expect(list.json<{ tokens: { lastUsedAt?: string }[] }>().tokens[0]?.lastUsedAt).toBe("2026-03-01T10:01:01.000Z");
  });

  it("validates the create body", async () => {
    for (const payload of [{ name: "", scopes: ["runs:read"] }, { name: "   ", scopes: ["runs:read"] }, { name: "x", scopes: [] }, { name: "x", scopes: ["nope"] }, {}]) {
      const res = await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(Object.keys(store.get().apiTokens)).toEqual([]);
  });
});

describe("requireScope", () => {
  it("answers 403 to a token without the scope and lets the scope and the cookie through", async () => {
    const { dir, cleanup } = await tempDir();
    const app = await buildApp(testConfig(dir), { webDir: path.join(dir, "no-web"), viewCache: false });
    try {
      app.get("/api/v1/_scoped", { preHandler: requireScope("runs:approve") }, async () => ({ ok: true }));
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "pw" } });
      const cookie = cookieOf(login);
      const tokenWith = async (scopes: string[]) =>
        (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload: { name: "t", scopes } })).json<{ token: string }>().token;

      const read = await app.inject({ method: "GET", url: "/api/v1/_scoped", headers: bearer(await tokenWith(["runs:read"])) });
      expect(read.statusCode).toBe(403);
      expect(read.json()).toEqual({ error: "missing scope runs:approve" });
      const approve = await app.inject({ method: "GET", url: "/api/v1/_scoped", headers: bearer(await tokenWith(["runs:approve"])) });
      expect(approve.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/_scoped", headers: { cookie } })).statusCode).toBe(200);
    } finally {
      await app.close();
      await cleanup();
    }
  });
});
