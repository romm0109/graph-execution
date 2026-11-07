import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { tempDir, testConfig } from "../test-helpers.js";

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
});
