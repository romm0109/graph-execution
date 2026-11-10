// open_graph through POST /api/internal/tools/:name, and the open-graph requests it queues.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";

const TOKEN = "t0ken";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const RUN = "gm-20261109-101500-ab12";

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
  const root = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
  expect(root.statusCode).toBe(201);
  rootTerminalId = (root.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

async function writeRun(): Promise<void> {
  const dir = path.join(wsDir, ".graph-execution", RUN);
  await mkdir(dir, { recursive: true });
  const state = stateSchema.parse({
    runId: RUN,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${RUN}`,
    specPath: "spec.md",
    tasksDir: path.join(wsDir, "tasks"),
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "merged", attempts: 1 }, "2": { status: "failed", attempts: 1 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-09T10:00:00.000Z",
    status: "failed",
  });
  await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
}

async function call(input: unknown, id = terminalId, cwd = wsDir) {
  const res = await app.inject({ method: "POST", url: "/api/internal/tools/open_graph", headers: AUTH, payload: { terminalId: id, cwd, input } });
  expect(res.statusCode).toBe(200);
  return res.json() as { text: string; isError?: boolean };
}

async function requests() {
  const res = await app.inject({ method: "GET", url: "/api/agent-requests", headers: { cookie } });
  return (res.json() as { requests: Record<string, unknown>[] }).requests;
}

describe.skipIf(process.platform === "win32")("open_graph", () => {
  it("is listed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/internal/tools", headers: AUTH });
    const { tools } = res.json() as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toContain("open_graph");
  });

  it("queues a folder graph with a selected node", async () => {
    const r = await call({ tasksDir: "tasks", node: "2" });
    expect(r).toEqual({ text: "Opened the graph of tasks in graph-manager. Node 2 is selected." });
    const list = await requests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "open-graph", workspaceId: "github~octo~hello", terminalId, tasksDir: "tasks", node: "2" });
    expect(list[0]).not.toHaveProperty("runId");
  });

  it("queues a run graph", async () => {
    await writeRun();
    const r = await call({ runId: RUN, node: "1" });
    expect(r).toEqual({ text: `Opened the graph of run ${RUN} in graph-manager. Node 1 is selected.` });
    expect((await requests())[0]).toMatchObject({ kind: "open-graph", runId: RUN, node: "1" });
    expect(await call({ runId: RUN, node: "9" })).toEqual({ isError: true, text: `unknown node 9 in run ${RUN}; nodes: 1, 2` });
  });

  it("rejects bad input without queueing", async () => {
    expect(await call({ tasksDir: "tasks", node: "9" })).toEqual({ isError: true, text: "unknown node 9 in tasks; nodes: 1, 2" });
    expect(await call({ tasksDir: "tasks", runId: RUN })).toEqual({ isError: true, text: "pass exactly one of runId and tasksDir" });
    expect(await call({})).toEqual({ isError: true, text: "pass exactly one of runId and tasksDir" });
    expect(await call({ runId: "nope" })).toEqual({ isError: true, text: "unknown run nope" });
    expect(await call({ tasksDir: "nope" })).toEqual({ isError: true, text: "tasks folder nope is not a folder inside the workspace" });
    expect(await call({ tasksDir: "empty" })).toEqual({ isError: true, text: "tasks folder empty has no task files" });
    expect(await call({ tasksDir: "tasks" }, rootTerminalId, rootDir)).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
    expect(await requests()).toEqual([]);
  });
});
