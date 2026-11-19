// `graph-execution … --sandbox` from a terminal (KAN-88): POST /api/internal/sandbox-runs against the fake Docker
// without exec (a started container writes the ready file and keeps "running").
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { Sandboxes, type ToolsMount } from "../sandbox.js";
import { toContainer } from "../sandbox-paths.js";
import { DataStore } from "../store.js";
import { tempDir, testConfig } from "../test-helpers.js";
import { runShim } from "../shim.js";
import { resolveWorkspace } from "../workspaces.js";
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

async function setup(overrides: Partial<Config> = {}): Promise<void> {
  const t = await tempDir();
  rmDir = t.cleanup;
  config = testConfig(t.dir, { dockerSocket: fake.socketPath, sandboxImage: "img:1", ...overrides });
  store = await DataStore.open(config.dataDir);
  app = await buildApp(config, { store, webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN });
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
    expect(scanArgs(["--resume", "--run", "gm-1", "--approve-plan"])).toEqual({ positional: [], run: "gm-1", resume: true, approvePlan: true });
    expect(scanArgs(["--resume", "--run", "gm-1", "--replan", "fb.md"])).toEqual({ positional: [], run: "gm-1", resume: true, replan: "fb.md" });
    expect(scanArgs(["--resume", "--replan=fb.md", "--run", "gm-1"])).toEqual({ positional: [], run: "gm-1", resume: true, replan: "fb.md" });
    expect(scanArgs(["--content", "c.md", "--provider", "fake"])).toEqual({ positional: [], content: "c.md", provider: "fake", resume: false });
    expect(scanArgs(["--content", "c.md", "--refs", "r.json", "--provider", "fake"])).toEqual({
      positional: [],
      content: "c.md",
      refs: "r.json",
      provider: "fake",
      resume: false,
    });
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
    expect(ct.Config.WorkingDir).toBe(toContainer(resolveWorkspace(config.workspacesDir, WS)!, wsDir, process.platform));
    expect(store.get().workspaceSettings[WS]?.sandbox).toBe(true);
  });

  it("resolves the paths relative to a cwd inside the workspace", async () => {
    await setup();
    const cwd = path.join(wsDir, "diamond");
    const res = await post({ cwd, args: [".", "--spec", "../spec.md", "--provider", "fake"] });
    expect(res.statusCode).toBe(201);
    expect([...fake.containers.values()][0]?.Config.WorkingDir).toBe(toContainer(resolveWorkspace(config.workspacesDir, WS)!, cwd, process.platform));
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

  it("starts a planned run (--content) in a sandbox", async () => {
    await setup();
    await writeFile(path.join(wsDir, "c.md"), "# Plan this\n");
    const res = await post({ cwd: wsDir, args: ["--content", "c.md", "--provider", "fake", "--web"] });
    expect(res.statusCode).toBe(201);
    const cmd = [...fake.containers.values()][0]!.Config.Cmd as string[];
    expect(cmd.join(" ")).toContain("--content c.md");
  });

  it("refuses --content with a tasks folder or --spec, or a content file that is not in the workspace", async () => {
    await setup();
    await writeFile(path.join(wsDir, "c.md"), "# Plan this\n");
    const both = await post({ cwd: wsDir, args: ["diamond", "--content", "c.md", "--provider", "fake"] });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({ error: "--content cannot be used with a tasks folder or --spec" });
    expect((await post({ cwd: wsDir, args: ["--content", "c.md", "--spec", "spec.md", "--provider", "fake"] })).statusCode).toBe(400);
    expect((await post({ cwd: wsDir, args: ["--content", "missing.md", "--provider", "fake"] })).json()).toEqual({
      error: "content: missing.md is not a file inside the workspace",
    });
    expect(fake.containers.size).toBe(0);
  });

  it("starts a planned run with --refs and refuses a refs file that is not in the workspace", async () => {
    await setup();
    await writeFile(path.join(wsDir, "c.md"), "# Plan this\n");
    await writeFile(path.join(wsDir, "r.json"), JSON.stringify([{ ref: "KAN-1" }]));
    expect((await post({ cwd: wsDir, args: ["--content", "c.md", "--refs", "missing.json", "--provider", "fake"] })).json()).toEqual({
      error: "refs: missing.json is not a file inside the workspace",
    });
    expect((await post({ cwd: wsDir, args: ["--content", "c.md", "--refs", "../../r.json", "--provider", "fake"] })).statusCode).toBe(400);
    expect(fake.containers.size).toBe(0);
    const res = await post({ cwd: wsDir, args: ["--content", "c.md", "--refs", "r.json", "--provider", "fake"] });
    expect(res.statusCode).toBe(201);
    const cmd = [...fake.containers.values()][0]!.Config.Cmd as string[];
    expect(cmd.join(" ")).toContain("--refs r.json");
  });

  it("needs --run with --resume", async () => {
    await setup();
    const res = await post({ cwd: wsDir, args: ["--resume"] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "--resume --sandbox needs --run <id>" });
  });

  describe("plan approval of a sandboxed run", () => {
    const ID = "gm-20260101-000000-abcd";
    const writeState = async () => {
      const runDir = path.join(wsDir, ".graph-execution", ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        path.join(runDir, "state.json"),
        JSON.stringify({
          runId: ID,
          provider: "fake",
          startingCommit: "0".repeat(40),
          integrationBranch: `graph/${ID}`,
          tasks: {},
          review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "awaiting-approval",
          sandbox: { image: "img:1" },
        }),
      );
    };

    it("passes --approve-plan to the container", async () => {
      await setup();
      await writeState();
      const res = await post({ cwd: wsDir, args: ["--resume", "--run", ID, "--approve-plan"] });
      expect(res.statusCode, res.body).toBe(201);
      const cmd = [...fake.containers.values()][0]!.Config.Cmd as string[];
      expect(cmd).toEqual(expect.arrayContaining(["--resume", "--run", ID, "--approve-plan"]));
    });

    it("passes --replan <file> to the container, relative to the workspace", async () => {
      await setup();
      await writeState();
      await mkdir(path.join(wsDir, "notes"), { recursive: true });
      await writeFile(path.join(wsDir, "notes", "fb.md"), "Split it in two\n");
      const res = await post({ cwd: path.join(wsDir, "notes"), args: ["--resume", "--run", ID, "--replan", "fb.md"] });
      expect(res.statusCode, res.body).toBe(201);
      const cmd = [...fake.containers.values()][0]!.Config.Cmd as string[];
      expect(cmd.join(" ")).toContain("--replan notes/fb.md");
    });

    it("refuses a --replan file outside the workspace, or both flags", async () => {
      await setup();
      await writeState();
      const outside = await post({ cwd: wsDir, args: ["--resume", "--run", ID, "--replan", "../../fb.md"] });
      expect(outside.statusCode).toBe(400);
      expect(outside.json()).toEqual({ error: "replan: ../../fb.md is not a file inside the workspace" });
      await writeFile(path.join(wsDir, "fb.md"), "x\n");
      const both = await post({ cwd: wsDir, args: ["--resume", "--run", ID, "--approve-plan", "--replan", "fb.md"] });
      expect(both.statusCode).toBe(400);
      expect(fake.containers.size).toBe(0);
    });
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
