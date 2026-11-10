// refresh_ui through POST /api/internal/tools/:name, and the request it queues.
import { mkdir } from "node:fs/promises";
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
  const res = await app.inject({ method: "POST", url: "/api/internal/tools/refresh_ui", headers: AUTH, payload: { terminalId: id, cwd, input } });
  expect(res.statusCode).toBe(200);
  return res.json() as { text: string; isError?: boolean };
}

async function requests() {
  const res = await app.inject({ method: "GET", url: "/api/agent-requests", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { requests: Record<string, unknown>[] }).requests;
}

async function listed(name: string) {
  const res = await app.inject({ method: "GET", url: "/api/internal/tools", headers: AUTH });
  const { tools } = res.json() as { tools: { name: string; inputSchema: { required?: string[] } }[] };
  return tools.find((t) => t.name === name);
}

describe.skipIf(process.platform === "win32")("refresh_ui", () => {
  it("is listed", async () => {
    expect(await listed("refresh_ui")).toBeDefined();
  });

  it("queues a refresh request without a terminal that cannot be acked", async () => {
    const r = await call({});
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("Asked graph-manager's open tabs to refresh.");
    const list = await requests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "refresh", workspaceId: "github~octo~hello" });
    expect(list[0]).not.toHaveProperty("terminalId");
    const ack = await app.inject({ method: "POST", url: `/api/agent-requests/${String(list[0]!.id)}/ack`, headers: { cookie } });
    expect(ack.statusCode).toBe(404);
    expect(await requests()).toHaveLength(1);
  });

  it("fails for a terminal outside any workspace", async () => {
    const r = await call({}, rootDir, rootTerminalId);
    expect(r).toEqual({ isError: true, text: "this terminal is not inside a graph-manager workspace" });
    expect(await requests()).toEqual([]);
  });
});
