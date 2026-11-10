// propose_graph through POST /api/internal/tools/:name, and acking its request with a result.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { TerminalManager } from "../terminals.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";

const TOKEN = "t0ken";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let wsDir: string;
let cookie: string;
let terminalId: string;

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  const config = testConfig(t.dir);
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, ".git"), { recursive: true });
  await mkdir(path.join(wsDir, "tasks"), { recursive: true });
  await writeFile(path.join(wsDir, "tasks", "1.json"), JSON.stringify({ id: "1", content: "# One", dependencies: [] }));
  await writeFile(path.join(wsDir, "tasks", "2.json"), JSON.stringify({ id: "2", content: "# Two", dependencies: ["1"] }));
  await mkdir(path.join(wsDir, "empty"), { recursive: true });
  await writeFile(path.join(wsDir, "spec.md"), "# spec\n");
  app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  cookie = cookieOf(login);
  const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~octo~hello" } });
  expect(res.statusCode).toBe(201);
  terminalId = (res.json() as { id: string }).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await cleanup();
});

async function call(input: unknown) {
  const res = await app.inject({ method: "POST", url: "/api/internal/tools/propose_graph", headers: AUTH, payload: { terminalId, cwd: wsDir, input } });
  expect(res.statusCode).toBe(200);
  return res.json() as { text: string; isError?: boolean };
}

async function requests() {
  const res = await app.inject({ method: "GET", url: "/api/agent-requests", headers: { cookie } });
  return (res.json() as { requests: { id: string; kind: string; prefill: Record<string, unknown> }[] }).requests;
}

const ack = (id: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/agent-requests/${id}/ack`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

describe.skipIf(process.platform === "win32")("propose_graph", () => {
  it("is listed with tasksDir and spec required", async () => {
    const res = await app.inject({ method: "GET", url: "/api/internal/tools", headers: AUTH });
    const { tools } = res.json() as { tools: { name: string; inputSchema: { required: string[] } }[] };
    const tool = tools.find((t) => t.name === "propose_graph");
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["tasksDir", "spec"]));
  });

  it("queues a propose-graph request", async () => {
    const r = await call({ tasksDir: "tasks", spec: "spec.md" });
    expect(r).toEqual({
      text: "Showed the graph of tasks to the user for approval. If they approve, the Start run form opens; if they reject, you'll get a message in this terminal.",
    });
    const list = await requests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "propose-graph", terminalId, prefill: { tasksDir: "tasks", spec: "spec.md" } });
  });

  it("rejects a missing spec, a bad folder and an empty folder without queueing", async () => {
    expect(await call({ tasksDir: "tasks", spec: "nope.md" })).toEqual({ isError: true, text: "spec nope.md is not a file inside the workspace" });
    expect(await call({ tasksDir: "nope", spec: "spec.md" })).toEqual({ isError: true, text: "tasks folder nope is not a folder inside the workspace" });
    expect(await call({ tasksDir: "empty", spec: "spec.md" })).toEqual({ isError: true, text: "tasks folder empty has no task files" });
    expect(await requests()).toEqual([]);
  });

  it("types a line into the terminal when the user rejects", async () => {
    const spy = vi.spyOn(TerminalManager.prototype, "typeWhenIdle");
    await call({ tasksDir: "tasks", spec: "spec.md" });
    const [req] = await requests();
    expect((await ack(req!.id, { result: "maybe" })).statusCode).toBe(400);
    expect((await ack(req!.id, { result: "rejected" })).statusCode).toBe(204);
    expect(spy).toHaveBeenCalledWith(terminalId, "[graph-manager] The user rejected the graph tasks.");
    expect(await requests()).toEqual([]);
  });

  it("types nothing when the user approves or closes", async () => {
    const spy = vi.spyOn(TerminalManager.prototype, "typeWhenIdle");
    await call({ tasksDir: "tasks", spec: "spec.md" });
    expect((await ack((await requests())[0]!.id, { result: "approved" })).statusCode).toBe(204);
    await call({ tasksDir: "tasks", spec: "spec.md" });
    expect((await ack((await requests())[0]!.id)).statusCode).toBe(204);
    expect(spy).not.toHaveBeenCalled();
  });
});
