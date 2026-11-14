import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { createUser, hashPassword } from "../accounts.js";
import { loginAs, tempDir, testConfig, repoOfId, writeProjectFolderForTest } from "../test-helpers.js";

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let dir: string;
let port: number;
let cookie: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  const config = testConfig(dir);
  await mkdir(config.workspacesDir, { recursive: true });
  await mkdir(path.join(config.workspacesDir, "github", "o", "r", ".git"), { recursive: true });
  app = await buildApp(config, { webDir: path.join(dir, "no-web"), viewCache: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "pw" } });
  const raw = res.headers["set-cookie"];
  cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(";")[0] ?? "";
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

function connect(id: string, headers: Record<string, string> = { cookie }) {
  return new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers });
}

describe.skipIf(process.platform === "win32")("terminal routes", () => {
  it("rejects a cwd outside the workspaces folder", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { cwd: "/etc" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cwd must be inside the workspaces folder" });
  });

  it("rejects a cwd that is a symlink inside the workspaces folder pointing out of it (F4)", async () => {
    const link = path.join(dir, "ws", "github", "o", "r", "escape");
    await symlink("/etc", link);
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { cwd: link } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a WebSocket upgrade from a foreign Origin, even with the session cookie (F1)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const status = await new Promise<number>((resolve, reject) => {
      const ws = connect(id, { cookie, origin: "http://127.0.0.1:3000" });
      ws.on("unexpected-response", (_req, r) => resolve(r.statusCode ?? 0));
      ws.on("open", () => reject(new Error("opened from a foreign origin")));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(403);
    const opened = await new Promise<boolean>((resolve) => {
      const ws = connect(id, { cookie, origin: `http://127.0.0.1:${port}` });
      ws.on("open", () => {
        ws.close();
        resolve(true);
      });
      ws.on("error", () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it("opens a terminal in a workspace", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~o~r" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ workspaceId: "github~o~r", cwd: path.join(dir, "ws", "github", "o", "r"), title: "o/r" });
    const missing = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~x~y" } });
    expect(missing.statusCode).toBe(404);
  });

  it("opens a terminal on a project; deleting the project closes it", async () => {
    await mkdir(path.join(dir, "ws", "github", "o", "s", ".git"), { recursive: true });
    const made = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "billing", repos: ["github~o~r", "github~o~s"].map(repoOfId) },
    });
    expect(made.statusCode).toBe(201);
    await writeProjectFolderForTest(path.join(dir, "ws"), "billing", "billing", ["github~o~r", "github~o~s"]);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload });
    const list = async () => (await app.inject({ method: "GET", url: "/api/terminals", headers: { cookie } })).json().terminals as { id: string; projectId?: string }[];

    const res = await post({ projectId: "billing" });
    expect(res.statusCode).toBe(201);
    const info = res.json() as { id: string; workspaceId?: string };
    expect(info).toMatchObject({ projectId: "billing", cwd: path.join(dir, "ws", ".projects", "billing"), title: "billing" });
    expect(info.workspaceId).toBeUndefined();
    expect(await list()).toEqual([expect.objectContaining({ id: info.id, projectId: "billing" })]);

    const missing = await post({ projectId: "nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "project not found" });
    const both = await post({ projectId: "billing", workspaceId: "github~o~r" });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({ error: "pass workspaceId or projectId, not both" });

    const gone = await app.inject({ method: "DELETE", url: "/api/projects/billing", headers: { cookie } });
    expect(gone.statusCode).toBe(204);
    expect(await list()).toEqual([]);
  });

  it("creates, streams over the WebSocket, and deletes", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(201);
    const { id, cwd } = res.json() as { id: string; cwd: string };
    expect(cwd).toBe(path.join(dir, "ws"));

    const ws = connect(id);
    const messages: { type: string; data?: string }[] = [];
    const got = new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
        messages.push(msg);
        if (msg.type === "data" && messages.filter((m) => m.type === "data").map((m) => m.data).join("").includes("gm-42")) resolve();
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: "input", data: "echo gm-$((40+2))\r" }));
    await got;
    expect(messages[0]?.type).toBe("replay");
    ws.close();

    const list = await app.inject({ url: "/api/terminals", headers: { cookie } });
    expect((list.json() as { terminals: { id: string }[] }).terminals.map((t) => t.id)).toEqual([id]);

    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/terminals", headers: { cookie } })).json()).toEqual({ terminals: [] });
  });

  it("refuses the WebSocket without a cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const ws = connect(id, {});
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, r) => resolve(r.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("closes the WebSocket with 4404 for an unknown terminal", async () => {
    const ws = connect("t999");
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(4404);
  });

  it("restarts an exited terminal over HTTP; a socket attached before keeps receiving (409 while running, 404 unknown)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { title: "sh" } });
    const { id } = res.json() as { id: string };
    expect((await app.inject({ method: "POST", url: `/api/terminals/${id}/restart`, headers: { cookie } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/terminals/t999/restart", headers: { cookie } })).statusCode).toBe(404);

    const ws = connect(id);
    const messages: { type: string; data?: string; code?: number }[] = [];
    const waitFor = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 20));
        check();
      });
    const data = () => messages.filter((m) => m.type === "data").map((m) => m.data).join("");
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as { type: string }));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ type: "input", data: "echo old-$((2+2)); exit 3\r" }));
    await waitFor(() => messages.some((m) => m.type === "exit"));
    expect(messages.find((m) => m.type === "exit")?.code).toBe(3);
    expect(data()).toContain("old-4");

    const restarted = await app.inject({ method: "POST", url: `/api/terminals/${id}/restart`, headers: { cookie } });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ id, title: "sh" });
    expect((restarted.json() as { status: string }).status).not.toBe("exited");
    await waitFor(() => messages.some((m) => m.type === "restart"));
    ws.send(JSON.stringify({ type: "input", data: "echo new-$((5+5))\r" }));
    await waitFor(() => data().includes("new-10"));
    ws.close();

    const ws2 = connect(id);
    const replay = await new Promise<string>((resolve) =>
      ws2.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data: string };
        if (msg.type === "replay") resolve(msg.data);
      }),
    );
    expect(replay).toContain("old-4");
    expect(replay).toContain("new-10");
    ws2.close();
  });

  it("renames with PATCH", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const ok = await app.inject({ method: "PATCH", url: `/api/terminals/${id}`, headers: { cookie }, payload: { title: "fix-auth" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, title: "fix-auth" });
    expect((await app.inject({ method: "PATCH", url: `/api/terminals/${id}`, headers: { cookie }, payload: { title: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/terminals/${id}`, headers: { cookie }, payload: { title: "x".repeat(201) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/terminals/t999", headers: { cookie }, payload: { title: "x" } })).statusCode).toBe(404);
  });

  it("lists and reaches only the user's own terminals; a terminal outside a session deletes with 204", async () => {
    const created = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = created.json() as { id: string };
    expect(created.json()).toMatchObject({ userId: "admin" });
    expect(created.json()).not.toHaveProperty("sessionId");
    await createUser(app.ctx.db, { username: "bob", displayName: "Bob", passwordHash: await hashPassword("bob-password-1") });
    const bob = await loginAs(app, "bob", "bob-password-1");
    expect((await app.inject({ method: "GET", url: "/api/terminals", headers: { cookie: bob } })).json()).toEqual({ terminals: [] });
    expect((await app.inject({ method: "GET", url: "/api/terminals", headers: { cookie } })).json().terminals.map((t: { id: string }) => t.id)).toEqual([id]);
    const foreign = await app.inject({ method: "DELETE", url: `/api/terminals/${id}`, headers: { cookie: bob } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: "terminal not found" });
    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${id}`, headers: { cookie } })).statusCode).toBe(204);
  });
});
