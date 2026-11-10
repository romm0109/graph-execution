// `graph-execution … --sandbox` from a terminal (KAN-88): POST /api/internal/sandbox-runs against the fake Docker
// without exec (a started container writes the ready file and keeps "running").
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { Sandboxes, type ToolsMount } from "../sandbox.js";
import { RunOrigins } from "../run-origins.js";
import { DataStore } from "../store.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";
import { runShim } from "../shim.js";
import { scanArgs } from "./internal.js";

const FIXTURES = fileURLToPath(new URL("../../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const WS = "github~octo~hello";
const TOKEN = "t0ken";
const RUN_ARGS = ["diamond", "--spec", "spec.md", "--provider", "fake"];

let fake: FakeDocker;
let app: FastifyInstance | undefined;
let store: DataStore;
let config: Config;
let wsDir: string;
let rmDir: (() => Promise<void>) | undefined;
let origins: RunOrigins;
// Terminals need a PTY.
const noPty = process.platform === "win32";

async function setup(overrides: Partial<Config> = {}): Promise<void> {
  const t = await tempDir();
  rmDir = t.cleanup;
  config = testConfig(t.dir, { dockerSocket: fake.socketPath, sandboxImage: "img:1", ...overrides });
  store = await DataStore.open(config.dataDir);
  origins = new RunOrigins();
  app = await buildApp(config, { store, webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN, runOrigins: origins });
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  const git = (...args: string[]) => execa("git", args, { cwd: wsDir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@example.com");
  await cp(path.join(FIXTURES, "diamond"), path.join(wsDir, "diamond"), { recursive: true });
  await cp(path.join(FIXTURES, "spec.md"), path.join(wsDir, "spec.md"));
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
}

/** Logs in and opens a terminal in the workspace; its id. */
async function openTerminal(): Promise<string> {
  const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  const res = await app!.inject({ method: "POST", url: "/api/terminals", headers: { cookie: cookieOf(login) }, payload: { workspaceId: WS } });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

function postOrigin(payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return app!.inject({ method: "POST", url: "/api/internal/run-origins", headers, payload });
}

function post(payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return app!.inject({ method: "POST", url: "/api/internal/sandbox-runs", headers, payload });
}

beforeEach(async () => {
  fake = await startFakeDocker();
  vi.spyOn(Sandboxes.prototype as unknown as { prepareTools: () => Promise<string | undefined> }, "prepareTools").mockImplementation(async function (
    this: { mount?: ToolsMount },
  ) {
    this.mount = { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
    return undefined;
  });
  vi.spyOn(Sandboxes.prototype as unknown as { buildImages: () => Promise<{ image: string; clisVolume: string }> }, "buildImages").mockImplementation(async function (
    this: { opts: { config: { sandboxImage?: string } } },
  ) {
    // The built image is the recipe's base here: these tests start containers of a known image.
    // The CLI volume start() checks for (review F5); empty is enough for the fake provider.
    await (this as unknown as { docker: { createVolume(n: string): Promise<unknown> } }).docker.createVolume("gm-clis-test");
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  await rmDir?.();
  rmDir = undefined;
  await fake.close();
});

describe("scanArgs", () => {
  it("finds the positional and the options the server needs", () => {
    expect(scanArgs(["--concurrency", "4", "diamond", "--spec=spec.md", "--provider", "fake", "--human-review"])).toEqual({
      positional: ["diamond"],
      spec: "spec.md",
      provider: "fake",
      resume: false,
    });
    expect(scanArgs(["--resume", "--run", "gm-1"])).toEqual({ positional: [], run: "gm-1", resume: true });
  });
});

describe("POST /api/internal/sandbox-runs", () => {
  it("needs the internal token", async () => {
    await setup();
    expect((await post({ cwd: wsDir, args: RUN_ARGS }, {})).statusCode).toBe(401);
    const wrong = await post({ cwd: wsDir, args: RUN_ARGS }, { authorization: "Bearer nope" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "bad internal token" });
    // The session cookie is not needed with the right token.
    expect((await post({ cwd: "/nowhere", args: RUN_ARGS })).statusCode).toBe(400);
  });

  it("refuses a cwd outside every workspace", async () => {
    await setup();
    const res = await post({ cwd: config.workspacesDir, args: RUN_ARGS });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "the terminal is not inside a workspace" });
  });

  it("starts a new run in a sandbox", async () => {
    await setup();
    const res = await post({ cwd: wsDir, args: [...RUN_ARGS, "--web"] });
    expect(res.statusCode).toBe(201);
    const { runId, viewUrl, url } = res.json<{ runId: string; viewUrl: string; url: string }>();
    expect(viewUrl).toBe(`/runs/${WS}/${runId}/view/`);
    expect(url.endsWith(`/runs/${WS}/${runId}`)).toBe(true);
    const all = [...fake.containers.values()];
    expect(all).toHaveLength(1);
    const ct = all[0]!;
    expect(ct.Name).toBe(`/gm-run-${runId}`);
    expect(ct.Config.Cmd).toEqual(["node", "/opt/gm-tools/graph-execution/dist/cli.js", ...RUN_ARGS, "--web-serve"]);
    expect(ct.Config.WorkingDir).toBe(wsDir);
    expect(store.get().workspaceSettings[WS]?.sandbox).toBe(true);
  });

  it.skipIf(noPty)("records the origin of a sandboxed run started from a terminal", async () => {
    await setup();
    const terminalId = await openTerminal();
    const res = await post({ cwd: wsDir, args: RUN_ARGS, terminalId });
    expect(res.statusCode).toBe(201);
    expect(origins.get(WS, res.json<{ runId: string }>().runId)).toBe(terminalId);
  });

  it("records no origin without a terminal id", async () => {
    await setup();
    expect((await post({ cwd: wsDir, args: RUN_ARGS })).statusCode).toBe(201);
    expect(origins.entries()).toEqual([]);
  });

  it("resolves the paths relative to a cwd inside the workspace", async () => {
    await setup();
    const cwd = path.join(wsDir, "diamond");
    const res = await post({ cwd, args: [".", "--spec", "../spec.md", "--provider", "fake"] });
    expect(res.statusCode).toBe(201);
    expect([...fake.containers.values()][0]?.Config.WorkingDir).toBe(cwd);
  });

  it("refuses subcommands, a missing provider and paths outside the workspace", async () => {
    await setup();
    expect((await post({ cwd: wsDir, args: ["suite", "--feature", "a:b", "--provider", "fake"] })).json()).toEqual({ error: "--sandbox works only for runs" });
    const noProvider = await post({ cwd: wsDir, args: ["diamond", "--spec", "spec.md"] });
    expect(noProvider.statusCode).toBe(400);
    expect(noProvider.json()).toEqual({ error: "missing required option --provider <name>" });
    expect((await post({ cwd: wsDir, args: ["nope", "--spec", "spec.md", "--provider", "fake"] })).json()).toEqual({
      error: "tasksDir: nope is not a folder inside the workspace",
    });
    expect((await post({ cwd: wsDir, args: ["diamond", "--spec", "../../x.md", "--provider", "fake"] })).json()).toEqual({
      error: "spec: ../../x.md is not a file inside the workspace",
    });
    expect(fake.containers.size).toBe(0);
  });

  it("needs --run with --resume", async () => {
    await setup();
    const res = await post({ cwd: wsDir, args: ["--resume"] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "--resume --sandbox needs --run <id>" });
  });

  it("answers 400 with the reason when Docker is not reachable", async () => {
    await setup({ dockerSocket: "/nonexistent.sock" });
    const res = await post({ cwd: wsDir, args: RUN_ARGS });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/^Docker is not reachable/);
  });

  it("answers the shim over a real loopback connection", async () => {
    await setup();
    await app!.listen({ host: "127.0.0.1", port: 0 });
    const a = app!.server.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const outs: string[] = [];
    const errs: string[] = [];
    const code = await runShim([...RUN_ARGS, "--web", "--sandbox"], { GM_INTERNAL_URL: base, GM_INTERNAL_TOKEN: TOKEN }, {
      cwd: wsDir,
      fetch,
      spawnEngine: async () => 1,
      out: (x) => outs.push(x),
      err: (x) => errs.push(x),
    });
    expect(errs).toEqual([]);
    expect(code).toBe(0);
    expect(outs.join("")).toMatch(new RegExp(`^Run gm-\\S+ started in a sandbox: ${base}/runs/${WS}/gm-\\S+\\n$`));
  });
});

describe.skipIf(noPty)("POST /api/internal/run-origins", () => {
  const RUN = "gm-20261109-120000-abcd";

  it("needs the internal token", async () => {
    await setup();
    const terminalId = await openTerminal();
    expect((await postOrigin({ terminalId, cwd: wsDir, runId: RUN }, {})).statusCode).toBe(401);
    const wrong = await postOrigin({ terminalId, cwd: wsDir, runId: RUN }, { authorization: "Bearer nope" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "bad internal token" });
    expect(origins.entries()).toEqual([]);
  });

  it("records the terminal of a run, from the workspace or a folder inside it", async () => {
    await setup();
    const terminalId = await openTerminal();
    const res = await postOrigin({ terminalId, cwd: wsDir, runId: RUN });
    expect(res.statusCode).toBe(204);
    expect(origins.get(WS, RUN)).toBe(terminalId);
    expect((await postOrigin({ terminalId, cwd: path.join(wsDir, "diamond"), runId: "gm-2" })).statusCode).toBe(204);
    expect(origins.get(WS, "gm-2")).toBe(terminalId);
  });

  it("refuses a bad cwd, run id or terminal", async () => {
    await setup();
    const terminalId = await openTerminal();
    const outside = await postOrigin({ terminalId, cwd: config.workspacesDir, runId: RUN });
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toEqual({ error: "the terminal is not inside a workspace" });
    const bad = await postOrigin({ terminalId, cwd: wsDir, runId: ".bad" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid run id" });
    const unknown = await postOrigin({ terminalId: "t999", cwd: wsDir, runId: RUN });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "unknown terminal t999" });
    const relative = await postOrigin({ terminalId, cwd: "github/octo/hello", runId: RUN });
    expect(relative.statusCode).toBe(400);
    expect(relative.json()).toEqual({ error: "cwd must be an absolute path" });
    expect(origins.entries()).toEqual([]);
  });

  it("is what the shim registers before it spawns the engine, over a real loopback connection", async () => {
    await setup();
    const terminalId = await openTerminal();
    await app!.listen({ host: "127.0.0.1", port: 0 });
    const a = app!.server.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    let seen: Record<string, string> | undefined;
    const errs: string[] = [];
    const code = await runShim(["diamond", "--spec", "spec.md", "--provider", "fake"], { GM_INTERNAL_URL: base, GM_INTERNAL_TOKEN: TOKEN, GM_TERMINAL_ID: terminalId }, {
      cwd: wsDir,
      fetch,
      spawnEngine: async (_args, env) => {
        seen = env;
        return 0;
      },
      out: () => {},
      err: (x) => errs.push(x),
    });
    expect(code).toBe(0);
    expect(errs).toEqual([]);
    const runId = seen?.GRAPH_EXECUTION_RUN_ID;
    expect(runId).toMatch(/^gm-/);
    expect(origins.get(WS, runId!)).toBe(terminalId);
  });
});
