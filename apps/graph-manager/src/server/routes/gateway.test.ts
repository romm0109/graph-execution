import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUser } from "../accounts.js";
import { buildApp } from "../app.js";
import { signIdentity } from "../identity.js";
import { tempDir, testConfig } from "../test-helpers.js";

const SECRET = "g".repeat(40);

let dir: string;
let cleanup: () => Promise<void>;
let app: FastifyInstance;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  app = await buildApp(testConfig(dir, { auth: "gateway", gatewaySecret: SECRET, password: "" }), { webDir: path.join(dir, "no-web"), viewCache: false });
});
afterEach(async () => {
  await app.close();
  await cleanup();
});

const as = (id: string): Record<string, string> => ({ "x-gm-identity": signIdentity({ id, name: id.toUpperCase() }, SECRET) });
const bearer = (secret = SECRET): Record<string, string> => ({ authorization: `Bearer ${secret}` });

describe("gateway user management", () => {
  it("needs the gateway secret as a bearer token", async () => {
    await app.inject({ url: "/api/health", headers: as("u1") });
    for (const headers of [{}, bearer("wrong"), { authorization: SECRET }, as("u1")]) {
      const res = await app.inject({ method: "POST", url: "/api/gateway/users/u1/disable", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "wrong gateway secret" });
      expect((await app.inject({ method: "DELETE", url: "/api/gateway/users/u1", headers })).statusCode).toBe(401);
    }
  });

  it("answers 404 for an unknown user", async () => {
    const res = await app.inject({ method: "POST", url: "/api/gateway/users/nobody/disable", headers: bearer() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no such user" });
    expect((await app.inject({ method: "DELETE", url: "/api/gateway/users/nobody", headers: bearer() })).statusCode).toBe(404);
  });

  it("disables a user: their requests answer 403 and the disable hooks run", async () => {
    const seen: string[] = [];
    app.ctx.userLifecycle.onDisable(async (id) => {
      seen.push(id);
    });
    app.ctx.userLifecycle.onDisable(async () => {
      throw new Error("a failing hook does not stop the others");
    });
    app.ctx.userLifecycle.onDisable(async (id) => {
      seen.push(`after:${id}`);
    });
    expect((await app.inject({ url: "/api/health", headers: as("u1") })).statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: "/api/gateway/users/u1/disable", headers: bearer() });
    expect(res.statusCode).toBe(204);
    expect(seen).toEqual(["u1", "after:u1"]);
    const after = await app.inject({ url: "/api/health", headers: as("u1") });
    expect(after.statusCode).toBe(403);
    expect(after.json()).toEqual({ error: "account disabled" });
  });

  it("deletes a user and their data; the next token creates a fresh user", async () => {
    const deleted: string[] = [];
    app.ctx.userLifecycle.onDelete(async (id) => {
      deleted.push(id);
    });
    await app.inject({ url: "/api/health", headers: as("u1") });
    await (await app.ctx.store.forUser({ id: "u1", name: "U1" })).update((d) => {
      d.sandboxLimits.cpus = 7;
    });
    const res = await app.inject({ method: "DELETE", url: "/api/gateway/users/u1", headers: bearer() });
    expect(res.statusCode).toBe(204);
    expect(deleted).toEqual(["u1"]);
    expect(await getUser(app.ctx.db, "u1")).toBeUndefined();
    expect(await app.ctx.db.query("SELECT user_id FROM user_data WHERE user_id = ?", ["u1"])).toEqual([]);

    expect((await app.inject({ url: "/api/health", headers: as("u1") })).statusCode).toBe(200);
    expect(await getUser(app.ctx.db, "u1")).toMatchObject({ disabled: false });
    expect((await app.ctx.store.forUser({ id: "u1", name: "U1" })).get().sandboxLimits.cpus).toBe(2);
  });

  it("does not exist in users mode", async () => {
    const users = await buildApp(testConfig(path.join(dir, "users")), { webDir: path.join(dir, "no-web"), viewCache: false });
    try {
      const res = await users.inject({ method: "POST", url: "/api/gateway/users/admin/disable", headers: bearer() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
      expect((await users.inject({ method: "DELETE", url: "/api/gateway/users/admin", headers: bearer() })).statusCode).toBe(404);
    } finally {
      await users.close();
    }
  });
});
