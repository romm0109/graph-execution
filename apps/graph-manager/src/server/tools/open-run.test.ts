// open_run through POST /api/internal/tools/:name, and the request it queues.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";

const RUN = "gm-20261109-101500-ab12";
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
  const res = await app.inject({ method: "POST", url: "/api/internal/tools/open_run", headers: AUTH, payload: { terminalId: id, cwd, input } });
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

describe.skipIf(process.platform === "win32")("open_run", () => {
  it("is listed with runId required", async () => {
    const tool = await listed("open_run");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["runId"]);
  });

  it("queues an open-run request for an existing run", async () => {
    await mkdir(path.join(wsDir, ".graph-execution", RUN), { recursive: true });
    const r = await call({ runId: RUN });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe(`Opened run ${RUN} in graph-manager.`);
    const list = await requests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "open-run", runId: RUN, terminalId, workspaceId: "github~octo~hello" });
  });

  it("rejects an unknown or invalid run id and queues nothing", async () => {
    expect(await call({ runId: "nope" })).toEqual({ isError: true, text: "unknown run nope" });
    expect(await call({ runId: "../x" })).toEqual({ isError: true, text: "unknown run ../x" });
    expect(await call({ runId: RUN })).toEqual({ isError: true, text: `unknown run ${RUN}` });
    expect(await requests()).toEqual([]);
  });

  it("fails for a terminal outside any workspace", async () => {
    const r = await call({ runId: RUN }, rootDir, rootTerminalId);
    expect(r).toEqual({ isError: true, text: "this terminal is not inside a graph-manager workspace" });
    expect(await requests()).toEqual([]);
  });
});
