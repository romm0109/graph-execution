import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { appWithLogin } from "../test-helpers.js";

type Ctx = Awaited<ReturnType<typeof appWithLogin>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const WS = "github~octo~hello";

async function withWorkspace(): Promise<Ctx> {
  const c = await appWithLogin();
  ctx = c;
  const dir = path.join(c.config.workspacesDir, "github", "octo", "hello");
  await mkdir(dir, { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return c;
}

const supervisor = (c: Ctx, method: "GET" | "PUT", payload?: unknown, id = WS, cookie = c.cookie) =>
  c.app.inject({
    method,
    url: `/api/workspaces/${id}/supervisor`,
    headers: cookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe("GET/PUT /api/workspaces/:id/supervisor", () => {
  it("answers report when unset", async () => {
    const c = await withWorkspace();
    const res = await supervisor(c, "GET");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "report" });
  });

  it("stores the mode with PUT and answers 204", async () => {
    const c = await withWorkspace();
    const put = await supervisor(c, "PUT", { mode: "act" });
    expect(put.statusCode).toBe(204);
    expect(put.body).toBe("");
    expect((await supervisor(c, "GET")).json()).toEqual({ mode: "act" });
    expect(c.store.get().workspaceSettings[WS]?.supervisor).toBe("act");
    expect((await supervisor(c, "PUT", { mode: "report" })).statusCode).toBe(204);
    expect((await supervisor(c, "GET")).json()).toEqual({ mode: "report" });
  });

  it("rejects another mode, a missing mode and extra keys with 400", async () => {
    const c = await withWorkspace();
    await supervisor(c, "PUT", { mode: "act" });
    for (const payload of [{ mode: "fix" }, {}, { mode: "act", extra: 1 }]) {
      expect((await supervisor(c, "PUT", payload)).statusCode).toBe(400);
    }
    expect(c.store.get().workspaceSettings[WS]?.supervisor).toBe("act");
  });

  it("answers 404 for an unknown workspace", async () => {
    const c = await withWorkspace();
    for (const res of [await supervisor(c, "GET", undefined, "github~octo~nope"), await supervisor(c, "PUT", { mode: "act" }, "github~octo~nope")]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "unknown workspace" });
    }
    // Unknown workspace wins over a bad body.
    expect((await supervisor(c, "PUT", { mode: "fix" }, "github~octo~nope")).statusCode).toBe(404);
  });

  it("requires login", async () => {
    const c = await withWorkspace();
    expect((await supervisor(c, "GET", undefined, WS, "")).statusCode).toBe(401);
    expect((await supervisor(c, "PUT", { mode: "act" }, WS, "")).statusCode).toBe(401);
    expect(c.store.get().workspaceSettings[WS]).toBeUndefined();
  });

  it("keeps the mode when the sandbox image settings are saved", async () => {
    const c = await withWorkspace();
    await supervisor(c, "PUT", { mode: "act" });
    const res = await c.app.inject({ method: "PUT", url: `/api/workspaces/${WS}/settings`, headers: { cookie: c.cookie }, payload: { source: "global" } });
    expect(res.statusCode).toBe(200);
    expect((await supervisor(c, "GET")).json()).toEqual({ mode: "act" });
  });
});
