// The built MCP command (dist/server/mcp.js) against a listening graph-manager; skipped until
// `npm run build -w graph-manager` made it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app.js";
import { cookieOf, tempDir, testConfig } from "./test-helpers.js";
import { defineTool } from "./tools/types.js";

const MCP = fileURLToPath(new URL("../../dist/server/mcp.js", import.meta.url));
const TOKEN = "t0ken";
const echoTool = defineTool({
  name: "echo_ws",
  description: "test",
  input: z.object({ say: z.string() }),
  run: async (i, tc) => ({ text: `${i.say}:${tc.workspace?.id ?? "none"}:${tc.terminal.id}` }),
});

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let port: number;
let terminalId: string;
let wsDir: string;

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  const config = testConfig(t.dir);
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, ".git"), { recursive: true });
  app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN, tools: [echoTool] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie: cookieOf(login) }, payload: { workspaceId: "github~octo~hello" } });
  terminalId = (res.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

/** Spawns mcp.js, sends `messages` and returns the responses by id once all with an id arrived. */
async function session(env: NodeJS.ProcessEnv, messages: Record<string, unknown>[]): Promise<Map<unknown, Record<string, unknown>>> {
  const child = spawn(process.execPath, [MCP], { env, cwd: wsDir, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const want = messages.filter((m) => m.id !== undefined).length;
    const got = new Map<unknown, Record<string, unknown>>();
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify([...got.values()])}`)), 10_000);
      createInterface({ input: child.stdout }).on("line", (line) => {
        const r = JSON.parse(line) as Record<string, unknown>;
        got.set(r.id, r);
        if (got.size >= want) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    await done;
    return got;
  } finally {
    child.kill();
  }
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

describe.skipIf(!existsSync(MCP) || process.platform === "win32")("dist/server/mcp.js", () => {
  it("lists and calls graph-manager's tools in a terminal", async () => {
    const env = { ...process.env, GM_INTERNAL_URL: `http://127.0.0.1:${port}`, GM_INTERNAL_TOKEN: TOKEN, GM_TERMINAL_ID: terminalId };
    const got = await session(env, [
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_ws", arguments: { say: "hi" } } },
    ]);
    expect((got.get(1)?.result as { serverInfo: { name: string } }).serverInfo.name).toBe("graph-manager");
    const tools = (got.get(2)?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["echo_ws"]);
    expect(got.get(3)?.result).toEqual({ content: [{ type: "text", text: `hi:github~octo~hello:${terminalId}` }], isError: false });
  });

  it("lists no tools outside a graph-manager terminal", async () => {
    const env = { ...process.env };
    delete env.GM_INTERNAL_URL;
    delete env.GM_INTERNAL_TOKEN;
    delete env.GM_TERMINAL_ID;
    const got = await session(env, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    expect(got.get(2)?.result).toEqual({ tools: [] });
  });
});
