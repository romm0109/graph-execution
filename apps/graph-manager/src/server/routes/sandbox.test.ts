import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { Sandboxes } from "../sandbox.js";
import { DATA_FILE } from "../store.js";
import { appWithLogin } from "../test-helpers.js";

let fake: FakeDocker;
let ctx: Awaited<ReturnType<typeof appWithLogin>> | undefined;

beforeEach(async () => {
  fake = await startFakeDocker();
  // The tools step is covered by sandbox-tools.test.ts.
  vi.spyOn(Sandboxes.prototype as unknown as { prepareTools: () => Promise<string | undefined> }, "prepareTools").mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
  await fake.close();
});

describe("GET /api/sandbox/status", () => {
  it("answers available with a reachable Docker", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    expect(fake.requests).toEqual([]);
    const res = await ctx.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: ctx.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true });
  });

  it("requires login", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    const res = await ctx.app.inject({ method: "GET", url: "/api/sandbox/status" });
    expect(res.statusCode).toBe(401);
  });

  it("answers unavailable with a reason when Docker is not reachable", async () => {
    ctx = await appWithLogin({ dockerSocket: "/nonexistent.sock" });
    const res = await ctx.app.inject({ method: "GET", url: "/api/sandbox/status", headers: { cookie: ctx.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ available: boolean; reason?: string }>();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/^Docker is not reachable at \/nonexistent\.sock/);
  });
});

describe("GET/PUT /api/settings/sandbox", () => {
  it("answers the defaults, then stores valid limits", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    const get = await ctx.app.inject({ method: "GET", url: "/api/settings/sandbox", headers: { cookie: ctx.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ limits: { cpus: 2, memoryMb: 4096, pids: 2048 } });

    const limits = { cpus: 4, memoryMb: 8192, pids: 4096 };
    const put = await ctx.app.inject({ method: "PUT", url: "/api/settings/sandbox", headers: { cookie: ctx.cookie }, payload: limits });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ limits });
    expect(ctx.store.get().sandboxLimits).toEqual(limits);
    const file = JSON.parse(await readFile(path.join(ctx.config.dataDir, DATA_FILE), "utf8"));
    expect(file.sandboxLimits).toEqual(limits);
  });

  it("rejects out-of-range values and unknown keys", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    const low = await ctx.app.inject({ method: "PUT", url: "/api/settings/sandbox", headers: { cookie: ctx.cookie }, payload: { cpus: 2, memoryMb: 100, pids: 2048 } });
    expect(low.statusCode).toBe(400);
    expect(low.json().error).toContain("memoryMb:");
    const extra = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/sandbox",
      headers: { cookie: ctx.cookie },
      payload: { cpus: 2, memoryMb: 4096, pids: 2048, swap: 1 },
    });
    expect(extra.statusCode).toBe(400);
    expect(ctx.store.get().sandboxLimits).toEqual({ cpus: 2, memoryMb: 4096, pids: 2048 });
  });

  it("requires login", async () => {
    ctx = await appWithLogin({ dockerSocket: fake.socketPath });
    expect((await ctx.app.inject({ method: "GET", url: "/api/settings/sandbox" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "PUT", url: "/api/settings/sandbox", payload: { cpus: 1, memoryMb: 512, pids: 64 } })).statusCode).toBe(401);
  });
});

describe("GET/PUT /api/workspaces/:id/settings", () => {
  const WS = "github~octo~hello";

  async function withWorkspace(): Promise<NonNullable<typeof ctx>> {
    const c = await appWithLogin({ dockerSocket: fake.socketPath });
    ctx = c;
    const dir = path.join(c.config.workspacesDir, "github", "octo", "hello");
    await mkdir(dir, { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
    return c;
  }

  const settings = (c: NonNullable<typeof ctx>, method: "GET" | "PUT", payload?: unknown, id = WS, cookie = c.cookie) =>
    c.app.inject({ method, url: `/api/workspaces/${id}/settings`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });

  it("answers no image for a new workspace, then stores one", async () => {
    const c = await withWorkspace();
    const get = await settings(c, "GET");
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ image: null, sandbox: false });

    const put = await settings(c, "PUT", { image: "python:3.12-bookworm" });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ image: "python:3.12-bookworm", sandbox: false });
    expect((await settings(c, "GET")).json()).toEqual({ image: "python:3.12-bookworm", sandbox: false });
  });

  it("removes the image on null and keeps the sandbox flag", async () => {
    const c = await withWorkspace();
    await settings(c, "PUT", { image: "python:3.12-bookworm" });
    await c.store.update((d) => {
      d.workspaceSettings[WS] = { ...d.workspaceSettings[WS], sandbox: true };
    });
    const put = await settings(c, "PUT", { image: null });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ image: null, sandbox: true });
    expect(c.store.get().workspaceSettings[WS]).toEqual({ sandbox: true });

    await settings(c, "PUT", { image: "node:22" });
    expect((await settings(c, "PUT", { image: "  " })).json()).toEqual({ image: null, sandbox: true });
  });

  it("rejects an invalid image, an unknown workspace and no login", async () => {
    const c = await withWorkspace();
    const bad = await settings(c, "PUT", { image: "bad image!" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "image: not a valid image reference" });
    expect((await settings(c, "PUT", { image: "node:22", extra: 1 })).statusCode).toBe(400);
    expect((await settings(c, "GET", undefined, "github~octo~nope")).statusCode).toBe(404);
    expect((await settings(c, "PUT", { image: "node:22" }, "github~octo~nope")).statusCode).toBe(404);
    expect((await settings(c, "GET", undefined, WS, "")).statusCode).toBe(401);
    expect((await settings(c, "PUT", { image: "node:22" }, WS, "")).statusCode).toBe(401);
  });
});
