import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { tempDir, testConfig, testStore } from "../test-helpers.js";
import { HostError } from "./types.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it("a HostError thrown in a route answers its status with { error }", async () => {
  const { dir, cleanup: rmDir } = await tempDir();
  const config = testConfig(dir);
  const { db, store } = await testStore();
  const app = await buildApp(config, { store, db, webDir: path.join(dir, "no-web"), viewCache: false });
  cleanup = async () => {
    await app.close();
    await db.close();
    await rmDir();
  };
  app.get("/host-error/:status", async (req) => {
    throw new HostError(Number((req.params as { status: string }).status), "host says no");
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  for (const status of [409, 503]) {
    const res = await app.inject({ method: "GET", url: `/host-error/${status}`, headers: { cookie } });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: "host says no" });
  }
});
