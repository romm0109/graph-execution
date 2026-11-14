// The tools API of `graph-manager-mcp` (src/server/mcp.ts): GET /api/internal/tools and POST /api/internal/tools/:name.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";
import { defineTool } from "../tools/types.js";

const TOKEN = "t0ken";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const echoTool = defineTool({
  name: "echo_ws",
  description: "test",
  input: z.object({ say: z.string() }),
  run: async (i, tc) => ({ text: `${i.say}:${tc.workspace?.id ?? "none"}:${tc.terminal.id}` }),
});
const failingTool = defineTool({
  name: "fail",
  description: "throws",
  input: z.object({}),
  run: async () => {
    throw new Error("boom");
  },
});

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let wsDir: string;
let terminalId: string;

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  const config = testConfig(t.dir);
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, ".git"), { recursive: true });
  app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN, tools: [echoTool, failingTool] });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  const cookie = cookieOf(login);
  const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~octo~hello" } });
  expect(res.statusCode).toBe(201);
  terminalId = (res.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

function call(name: string, payload: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method: "POST", url: `/api/internal/tools/${name}`, headers, payload });
}

describe.skipIf(process.platform === "win32")("internal tools API", () => {
  it("lists the tools only with the internal token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/internal/tools" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/internal/tools", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/api/internal/tools", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; description: string; inputSchema: { type: string; required: string[] } }[] };
    expect(tools.map((t) => t.name)).toEqual(["echo_ws", "fail"]);
    expect(tools[0]).toMatchObject({ name: "echo_ws", description: "test", inputSchema: { type: "object", required: ["say"] } });
  });

  it("calls a tool for the terminal and its workspace", async () => {
    expect(terminalId).toBe("t1");
    const res = await call("echo_ws", { terminalId, cwd: wsDir, input: { say: "hi" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "hi:github~octo~hello:t1" });
  });

  it("answers invalid arguments and a throwing tool with error results", async () => {
    const bad = await call("echo_ws", { terminalId, cwd: wsDir, input: { say: 1 } });
    expect(bad.statusCode).toBe(200);
    const body = bad.json() as { text: string; isError: boolean };
    expect(body.isError).toBe(true);
    expect(body.text).toMatch(/^invalid arguments/);
    const missing = await call("echo_ws", { terminalId, cwd: wsDir });
    expect((missing.json() as { isError: boolean }).isError).toBe(true);
    const thrown = await call("fail", { terminalId, cwd: wsDir, input: {} });
    expect(thrown.statusCode).toBe(200);
    expect(thrown.json()).toEqual({ text: "boom", isError: true });
  });

  it("rejects unknown tools, unknown terminals, relative cwds and a missing token", async () => {
    const nope = await call("nope", { terminalId, cwd: wsDir, input: {} });
    expect(nope.statusCode).toBe(404);
    expect(nope.json()).toEqual({ error: "unknown tool nope" });
    const t99 = await call("echo_ws", { terminalId: "t99", cwd: wsDir, input: { say: "hi" } });
    expect(t99.statusCode).toBe(400);
    expect(t99.json()).toEqual({ error: "unknown terminal t99" });
    const rel = await call("echo_ws", { terminalId, cwd: "rel", input: { say: "hi" } });
    expect(rel.statusCode).toBe(400);
    expect(rel.json()).toEqual({ error: "cwd must be an absolute path" });
    const noBody = await call("echo_ws", {});
    expect(noBody.statusCode).toBe(400);
    expect((await call("echo_ws", { terminalId, cwd: wsDir, input: { say: "hi" } }, {})).statusCode).toBe(401);
  });
});
