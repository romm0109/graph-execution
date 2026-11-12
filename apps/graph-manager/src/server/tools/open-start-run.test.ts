// open_start_run through POST /api/internal/tools/:name, and the queue it fills (GET/POST /api/agent-requests).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";

const TOKEN = "t0ken";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let wsDir: string;
let rootDir: string;
let cookie: string;
let terminalId: string;
let rootTerminalId: string;

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  const config = testConfig(t.dir);
  rootDir = config.workspacesDir;
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, ".git"), { recursive: true });
  await mkdir(path.join(wsDir, "tasks"), { recursive: true });
  await writeFile(path.join(wsDir, "tasks", "1.json"), "{}");
  await writeFile(path.join(wsDir, "spec.md"), "# spec\n");
  app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  cookie = cookieOf(login);
  const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~octo~hello" } });
  expect(res.statusCode).toBe(201);
  terminalId = (res.json() as { id: string }).id;
  const root = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
  expect(root.statusCode).toBe(201);
  rootTerminalId = (root.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

async function call(input: unknown, cwd = wsDir, id = terminalId) {
  const res = await app.inject({ method: "POST", url: "/api/internal/tools/open_start_run", headers: AUTH, payload: { terminalId: id, cwd, input } });
  expect(res.statusCode).toBe(200);
  return res.json() as { text: string; isError?: boolean };
}

async function requests() {
  const res = await app.inject({ method: "GET", url: "/api/agent-requests", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { requests: { id: string; kind: string; workspaceId: string; terminalId: string; prefill: Record<string, unknown> }[] }).requests;
}

describe.skipIf(process.platform === "win32")("open_start_run", () => {
  it("is listed with tasksDir and spec required", async () => {
    const res = await app.inject({ method: "GET", url: "/api/internal/tools", headers: AUTH });
    const { tools } = res.json() as { tools: { name: string; inputSchema: { required: string[] } }[] };
    const tool = tools.find((t) => t.name === "open_start_run");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["tasksDir", "spec"]));
  });

  it("queues a start-run request with workspace-relative paths", async () => {
    const r = await call({ tasksDir: "tasks", spec: "spec.md" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Opened the Start run form/);
    expect(r.text).toContain("tasks folder tasks and spec spec.md");
    const list = await requests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "start-run", workspaceId: "github~octo~hello", terminalId, prefill: { tasksDir: "tasks", spec: "spec.md" } });
  });

  it("resolves paths relative to a subfolder cwd", async () => {
    const r = await call({ tasksDir: ".", spec: "../spec.md" }, path.join(wsDir, "tasks"));
    expect(r.isError).toBeFalsy();
    expect((await requests())[0]!.prefill).toEqual({ tasksDir: "tasks", spec: "spec.md" });
  });

  it("keeps the provider and options", async () => {
    await call({ tasksDir: "tasks", spec: "spec.md", provider: "fake", options: { concurrency: 2 } });
    expect((await requests())[0]!.prefill).toEqual({ tasksDir: "tasks", spec: "spec.md", provider: "fake", options: { concurrency: 2 } });
  });

  it("keeps the review provider in the prefill", async () => {
    const r = await call({ tasksDir: "tasks", spec: "spec.md", options: { reviewProvider: "claude" } });
    expect(r.isError).toBeFalsy();
    expect((await requests())[0]!.prefill).toEqual({ tasksDir: "tasks", spec: "spec.md", options: { reviewProvider: "claude" } });
  });

  it("rejects a missing spec, a folder outside and a terminal outside workspaces without queueing", async () => {
    expect(await call({ tasksDir: "tasks", spec: "nope.md" })).toEqual({ isError: true, text: "spec nope.md is not a file inside the workspace" });
    expect(await call({ tasksDir: "../../..", spec: "spec.md" })).toMatchObject({ isError: true, text: "tasks folder ../../.. is not a folder inside the workspace" });
    expect(await call({ tasksDir: "spec.md", spec: "spec.md" })).toMatchObject({ isError: true });
    expect(await call({ tasksDir: "tasks", spec: "tasks" })).toMatchObject({ isError: true });
    expect(await call({ tasksDir: "tasks", spec: "spec.md" }, rootDir, rootTerminalId)).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
    expect(await requests()).toEqual([]);
  });

  it("acks requests behind the session cookie", async () => {
    await call({ tasksDir: "tasks", spec: "spec.md" });
    const [req] = await requests();
    expect((await app.inject({ method: "GET", url: "/api/agent-requests" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/agent-requests/${req!.id}/ack` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/agent-requests/${req!.id}/ack`, headers: { cookie } })).statusCode).toBe(204);
    expect(await requests()).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/agent-requests/${req!.id}/ack`, headers: { cookie } })).statusCode).toBe(404);
  });
});
