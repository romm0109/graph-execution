// open_start_run through POST /api/internal/tools/:name, and the queue it fills (GET/POST /api/agent-requests).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { cookieOf, tempDir, testConfig, repoOfId, writeProjectFolderForTest } from "../test-helpers.js";

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
  it("is listed with tasksDir, spec and project, none of them required", async () => {
    const res = await app.inject({ method: "GET", url: "/api/internal/tools", headers: AUTH });
    const { tools } = res.json() as { tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[] };
    const tool = tools.find((t) => t.name === "open_start_run");
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(expect.arrayContaining(["tasksDir", "spec", "project", "provider", "options"]));
    expect(tool!.inputSchema.required ?? []).toEqual([]);
  });

  it("needs both paths in a workspace terminal", async () => {
    const text = "tasksDir and spec are required in a workspace terminal";
    expect(await call({})).toEqual({ isError: true, text });
    expect(await call({ tasksDir: "tasks" })).toEqual({ isError: true, text });
    expect(await call({ spec: "spec.md" })).toEqual({ isError: true, text });
    expect(await requests()).toEqual([]);
  });

  describe("on a project", () => {
    let projectTerminalId: string;
    let projectDir: string;

    beforeEach(async () => {
      await mkdir(path.join(rootDir, "github", "octo", "web", ".git"), { recursive: true });
      const made = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { name: "billing", repos: ["github~octo~hello", "github~octo~web"].map(repoOfId) },
      });
      expect(made.statusCode).toBe(201);
      await writeProjectFolderForTest(rootDir, "billing", "billing", ["github~octo~hello", "github~octo~web"]);
      projectDir = (made.json() as { path: string }).path;
      const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { projectId: "billing" } });
      expect(res.statusCode).toBe(201);
      projectTerminalId = (res.json() as { id: string }).id;
    });

    it("queues a request for the project, without paths", async () => {
      const r = await call({ provider: "fake", options: { humanReview: true } }, projectDir, projectTerminalId);
      expect(r).toEqual({
        text: "Opened the Start run form of project billing in graph-manager. The user will review the options and start the run; do not start it yourself.",
      });
      const list = (await requests()) as unknown as Record<string, unknown>[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ kind: "start-run", workspaceId: "project~billing", projectId: "billing", terminalId: projectTerminalId });
      expect(list[0]!.prefill).toEqual({ provider: "fake", options: { humanReview: true } });
    });

    it("targets the project wherever the agent is, and ignores the paths", async () => {
      // The agent has `cd`'d into a repo: by its link, then by the workspace's real path.
      for (const cwd of [path.join(projectDir, "repos", "hello"), wsDir]) {
        const r = await call({ tasksDir: "tasks", spec: "spec.md" }, cwd, projectTerminalId);
        expect(r.isError, cwd).toBeFalsy();
        const list = (await requests()) as unknown as Record<string, unknown>[];
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ workspaceId: "project~billing", projectId: "billing" });
        expect(list[0]!.prefill).toEqual({});
      }
    });

    it("opens the project's form from a plain terminal inside the project folder", async () => {
      const r = await call({ project: true }, path.join(projectDir, "tasks"), rootTerminalId);
      expect(r.text).toContain("of project billing");
      expect((await requests())[0]).toMatchObject({ workspaceId: "project~billing", terminalId: rootTerminalId });
    });

    it("refuses project: true where there is no project", async () => {
      expect(await call({ project: true })).toEqual({ isError: true, text: "this terminal is not on a graph-manager project" });
      expect(await call({ project: true }, rootDir, rootTerminalId)).toEqual({ isError: true, text: "this terminal is not on a graph-manager project" });
      expect(await requests()).toEqual([]);
    });
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
