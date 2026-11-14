import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LINK_TTL_MS,
  createPasswordLink,
  createUser,
  findUserByUsername,
  hashPassword,
  listUsers,
  usePasswordLink,
  verifyPassword,
} from "./accounts.js";
import { buildApp } from "./app.js";
import { usersCommand } from "./cli/users.js";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db/db.js";
import { appWithLogin, cookieOf, loginAs, memoryDb, signUp, tempDir, testConfig } from "./test-helpers.js";

describe("accounts module", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("refuses a duplicate username", async () => {
    await createUser(db, { username: "erin", displayName: "Erin" });
    await expect(createUser(db, { username: "erin", displayName: "Erin 2" })).rejects.toMatchObject({ statusCode: 409, message: "username taken" });
    expect((await listUsers(db)).map((u) => u.username)).toEqual(["erin"]);
  });

  it("makes a link work once, and not after it expired", async () => {
    await createUser(db, { username: "erin", displayName: "Erin" });
    const token = await createPasswordLink(db, "erin");
    expect((await usePasswordLink(db, token))?.id).toBe("erin");
    expect(await usePasswordLink(db, token)).toBeUndefined();
    const late = await createPasswordLink(db, "erin");
    expect(await usePasswordLink(db, late, new Date(Date.now() + LINK_TTL_MS + 1))).toBeUndefined();
    // A new link ends the earlier unused ones.
    const first = await createPasswordLink(db, "erin");
    const second = await createPasswordLink(db, "erin");
    expect(await usePasswordLink(db, first)).toBeUndefined();
    expect((await usePasswordLink(db, second))?.id).toBe("erin");
  });
});

describe("account routes", () => {
  let t: Awaited<ReturnType<typeof appWithLogin>>;
  afterEach(async () => {
    await t.cleanup();
  });

  it("answers 404 to sign-up while it is closed", async () => {
    t = await appWithLogin();
    const res = await t.app.inject({ method: "POST", url: "/api/auth/signup", payload: { username: "alice", password: "alice-secret" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "sign-up is closed" });
  });

  it("signs up with open sign-up and validates the input", async () => {
    t = await appWithLogin({ signup: "open" });
    expect((await t.app.inject({ url: "/api/auth/info" })).json()).toMatchObject({ signup: true });
    const cookie = await signUp(t.app, "alice", "alice-secret", "Alice A.");
    const me = await t.app.inject({ url: "/api/account", headers: { cookie } });
    expect(me.json()).toEqual({ id: "alice", username: "alice", displayName: "Alice A." });

    const post = (payload: object) => t.app.inject({ method: "POST", url: "/api/auth/signup", payload });
    const taken = await post({ username: "alice", password: "another-secret" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "username taken" });
    const bad = await post({ username: "a b", password: "another-secret" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "username must be 3–32 characters of a-z, 0-9, _ and -" });
    const short = await post({ username: "bobby", password: "123456789" });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toEqual({ error: "password must be at least 10 characters" });
  });

  it("gives every user their own data", async () => {
    t = await appWithLogin({ signup: "open" });
    const alice = await signUp(t.app, "alice", "alice-secret");
    const limits = { cpus: 3, memoryMb: 2048, pids: 512 };
    const put = await t.app.inject({ method: "PUT", url: "/api/settings/sandbox", headers: { cookie: alice }, payload: { limits } });
    expect(put.statusCode).toBe(200);
    const mine = await t.app.inject({ url: "/api/settings/sandbox", headers: { cookie: alice } });
    expect(mine.json<{ limits: unknown }>().limits).toEqual(limits);
    const admins = await t.app.inject({ url: "/api/settings/sandbox", headers: { cookie: t.cookie } });
    expect(admins.json<{ limits: unknown }>().limits).not.toEqual(limits);
    const me = await t.app.inject({ url: "/api/auth/me", headers: { cookie: alice } });
    expect(me.json()).toEqual({ user: { id: "alice", name: "alice" }, mode: "users" });
  });

  it("changes the display name and the password, ending the user's other sessions", async () => {
    t = await appWithLogin({ signup: "open" });
    const first = await signUp(t.app, "alice", "alice-secret");
    const other = await loginAs(t.app, "alice", "alice-secret");
    const patch = (cookie: string, payload: object) => t.app.inject({ method: "PATCH", url: "/api/account", headers: { cookie }, payload });

    const named = await patch(first, { displayName: "Alice" });
    expect(named.statusCode).toBe(200);
    expect(named.json()).toEqual({ id: "alice", username: "alice", displayName: "Alice" });
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie: other } })).json()).toMatchObject({ user: { name: "Alice" } });

    const wrong = await patch(first, { currentPassword: "nope-nope-nope", newPassword: "new-secret-1" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: "current password is wrong" });
    expect((await patch(first, { currentPassword: "alice-secret", newPassword: "short" })).json()).toEqual({
      error: "password must be at least 10 characters",
    });

    const changed = await patch(first, { currentPassword: "alice-secret", newPassword: "new-secret-1" });
    expect(changed.statusCode).toBe(200);
    const renewed = cookieOf(changed);
    expect(renewed).toMatch(/^gm_session=/);
    expect((await t.app.inject({ url: "/api/account", headers: { cookie: renewed } })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/account", headers: { cookie: other } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/api/account", headers: { cookie: first } })).statusCode).toBe(401);
    // Other users keep their sessions.
    expect((await t.app.inject({ url: "/api/account", headers: { cookie: t.cookie } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-secret" } })).statusCode).toBe(401);
    await loginAs(t.app, "alice", "new-secret-1");
  });

  it("sets the password with a link once", async () => {
    t = await appWithLogin();
    await createUser(t.db, { username: "dana", displayName: "Dana" });
    const token = await createPasswordLink(t.db, "dana");
    const set = (password: string) => t.app.inject({ method: "POST", url: "/api/auth/set-password", payload: { token, password } });
    expect((await set("short")).json()).toEqual({ error: "password must be at least 10 characters" });
    const ok = await set("dana-secret-1");
    expect(ok.statusCode).toBe(204);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie: cookieOf(ok) } })).json()).toMatchObject({ user: { id: "dana" } });
    const again = await set("dana-secret-2");
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "link expired or used" });
    await loginAs(t.app, "dana", "dana-secret-1");
  });
});

describe("graph-manager users", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let env: NodeJS.ProcessEnv;
  let logs: string[];
  let errors: string[];
  const out = { log: (l: string) => logs.push(l), error: (l: string) => errors.push(l) };
  const run = (...argv: string[]) => usersCommand(argv, env, out);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    env = { GM_DATA_DIR: path.join(dir, "data"), GM_WORKSPACES_DIR: path.join(dir, "ws"), GM_PORT: "7999" };
    logs = [];
    errors = [];
  });
  afterEach(async () => {
    await cleanup();
  });

  const appOn = (overrides: Partial<Config> = {}): Promise<FastifyInstance> =>
    buildApp(testConfig(dir, overrides), { webDir: path.join(dir, "no-web"), viewCache: false });

  it("refuses in gateway mode", async () => {
    env = { ...env, GM_AUTH: "gateway", GM_GATEWAY_SECRET: "s".repeat(32) };
    expect(await run("list")).toBe(2);
    expect(errors).toEqual(["error: accounts are managed by the gateway (GM_AUTH=gateway)"]);
  });

  it("adds a user whose link sets the password, lists and disables users", async () => {
    expect(await run("list")).toBe(0);
    expect(logs).toEqual(["No users."]);
    logs = [];

    expect(await run("add", "dana", "--name", "Dana D.")).toBe(0);
    expect(logs[0]).toBe("Created user dana.");
    const link = /^Set-password link \(valid 7 days, works once\): (http:\/\/127\.0\.0\.1:7999\/set-password\?token=([A-Za-z0-9_-]+))$/.exec(logs[1] ?? "");
    expect(link).not.toBeNull();
    const token = link?.[2] ?? "";

    const app = await appOn();
    try {
      const set = await app.inject({ method: "POST", url: "/api/auth/set-password", payload: { token, password: "dana-secret-1" } });
      expect(set.statusCode).toBe(204);
      await loginAs(app, "dana", "dana-secret-1");

      logs = [];
      expect(await run("list")).toBe(0);
      expect(logs).toHaveLength(2);
      // Oldest first: dana was added before the server first started and created admin.
      expect(logs[0]).toMatch(/^dana\tDana D\.\t\d{4}-\d{2}-\d{2}\tactive$/);
      expect(logs[1]).toMatch(/^admin\tadmin\t\d{4}-\d{2}-\d{2}\tactive$/);

      logs = [];
      expect(await run("reset", "dana", "--url", "https://gm.example.com/")).toBe(0);
      expect(logs[0]).toMatch(/^Set-password link \(valid 7 days, works once\): https:\/\/gm\.example\.com\/set-password\?token=[A-Za-z0-9_-]+$/);

      logs = [];
      expect(await run("disable", "dana")).toBe(0);
      expect(logs).toEqual(["Disabled dana. A running graph-manager ends their terminals and sessions within a minute."]);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "dana", password: "dana-secret-1" } });
      expect(login.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("reports errors with exit codes", async () => {
    expect(await run("disable", "nobody")).toBe(1);
    expect(errors).toEqual(["error: no user nobody"]);
    errors = [];
    expect(await run("add", "x")).toBe(1);
    expect(errors).toEqual(["error: username must be 3–32 characters of a-z, 0-9, _ and -"]);
    errors = [];
    expect(await run("add", "erin")).toBe(0);
    expect(await run("add", "erin")).toBe(1);
    expect(errors).toEqual(["error: username taken"]);
    errors = [];
    expect(await run()).toBe(2);
    expect(errors[0]).toMatch(/^usage: graph-manager users/);
    expect(await run("nope")).toBe(2);
  });

  it("makes an existing install's password the admin's", async () => {
    const adminHash = async (): Promise<string | null> => {
      const db = await openDb(testConfig(dir));
      try {
        return (await findUserByUsername(db, "admin"))?.passwordHash ?? null;
      } finally {
        await db.close();
      }
    };
    let app = await appOn({ password: "old-password", passwordSource: "file" });
    expect(app.adminStatus).toEqual({ adminMatches: true, users: 1 });
    await app.close();
    expect(await verifyPassword("old-password", await adminHash())).toBe(true);

    app = await appOn({ password: "other-password", passwordSource: "file" });
    expect(app.adminStatus).toEqual({ adminMatches: false, users: 1 });
    await app.close();
    expect(await verifyPassword("old-password", await adminHash())).toBe(true);

    app = await appOn({ password: "env-password", passwordSource: "env" });
    expect(app.adminStatus).toEqual({ adminMatches: true, users: 1 });
    await app.close();
    expect(await verifyPassword("env-password", await adminHash())).toBe(true);
  });
});
