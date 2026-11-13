// POST /api/v1/workspaces/:ws/runs (docs/prd/automation-api.md): a run from free markdown content.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { defaultGraphExecutionBin } from "../config.js";
import { inputsDirOf } from "../inputs.js";
import { Sandboxes, type ToolsMount } from "../sandbox.js";
import { appWithLogin } from "../test-helpers.js";
import { NO_PROVIDER } from "./v1.js";

const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
if (!built) console.warn(`skipping the v1 start-run test: ${BIN} is missing; run \`npm run build -w graph-execution\` first`);

const WS = "github~octo~hello";
const WS2 = "gitlab~grp~proj";
const URL_ = `/api/v1/workspaces/${WS}/runs`;

let ctx: Awaited<ReturnType<typeof appWithLogin>> | undefined;
let wsDir: string;
/** PIDs of run processes this test started, stopped in afterEach if still alive. */
let started: number[];

const bearer = (t: string) => ({ authorization: "Bearer " + t });

async function token(scopes: string[]): Promise<{ id: string; token: string }> {
  const res = await ctx!.app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: ctx!.cookie }, payload: { name: "t", scopes } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function gitInit(...parts: string[]): Promise<string> {
  const dir = path.join(ctx!.config.workspacesDir, ...parts);
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) => execa("git", args, { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@example.com");
  await writeFile(path.join(dir, "README.md"), "# hello\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  return dir;
}

async function setup(overrides: Parameters<typeof appWithLogin>[0] = {}): Promise<NonNullable<typeof ctx>> {
  ctx = await appWithLogin(overrides);
  wsDir = await gitInit("github", "octo", "hello");
  return ctx;
}

function post(t: string, payload: unknown, url = URL_) {
  return ctx!.app.inject({ method: "POST", url, headers: bearer(t), payload: payload as Record<string, unknown> });
}

async function poll<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(() => {
  started = [];
});

afterEach(async () => {
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  await ctx?.cleanup();
  ctx = undefined;
});

describe("POST /api/v1/workspaces/:ws/runs: a start that fails", () => {
  it("removes the inputs of a start that failed", async () => {
    // sandbox defaults to true and Docker is not reachable: the start fails after the inputs were written.
    await setup({ dockerSocket: path.join(tmpdir(), `gm-no-docker-${process.pid}.sock`) });
    const t = (await token(["runs:start"])).token;
    const res = await post(t, { content: "x", provider: "fake", refs: [{ ref: "A" }] });
    expect(res.statusCode).toBe(400);
    const inputs = path.join(ctx!.config.dataDir, "inputs");
    expect(existsSync(inputs) ? await readdir(inputs) : []).toEqual([]);
    const runs = path.join(wsDir, ".graph-execution");
    expect(existsSync(runs) ? await readdir(runs) : []).toEqual([]);
  });
});

describe("POST /api/v1/workspaces/:ws/runs: checks before a start", () => {
  let t: string;
  beforeEach(async () => {
    await setup();
    t = (await token(["runs:start", "runs:read"])).token;
  });

  it("answers 404 for an unknown workspace", async () => {
    const res = await post(t, { content: "x", provider: "fake", sandbox: false }, "/api/v1/workspaces/github~octo~nope/runs");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "unknown workspace" });
  });

  it.each([
    ["an empty body", {}],
    ["content that is too long", { content: "x".repeat(200_001) }],
    ["duplicate refs", { content: "x", refs: [{ ref: "A" }, { ref: "A" }] }],
    ["a ref URL that is not http(s)", { content: "x", refs: [{ ref: "A", url: "javascript:x" }] }],
    ["an unknown gate", { content: "x", gate: "x" }],
    ["an unknown provider", { content: "x", provider: "nope" }],
  ])("answers 400 for %s", async (_name, body) => {
    const res = await post(t, { provider: "fake", sandbox: false, ...body });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json<{ error: string }>().error).toBe("string");
  });

  it("names the duplicate ref", async () => {
    const res = await post(t, { content: "x", provider: "fake", sandbox: false, refs: [{ ref: "A" }, { ref: "A" }] });
    expect(res.json()).toEqual({ error: "refs: duplicate ref A" });
  });

  it("answers 400 without a provider and no saved default", async () => {
    const res = await post(t, { content: "x", sandbox: false });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: NO_PROVIDER });
    expect(NO_PROVIDER).toBe("no provider: pass provider or start a run in this workspace once");
  });

  it("answers 403 for a token without runs:start", async () => {
    const reader = (await token(["runs:read"])).token;
    const res = await post(reader, { content: "x", provider: "fake", sandbox: false });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "missing scope runs:start" });
  });

  it("answers an idempotency key seen before in the workspace with the first run (200)", async () => {
    const runId = "gm-20260101-000000-abcd";
    await ctx!.store.update((d) => {
      d.apiRuns[`${WS}/${runId}`] = { refs: [], openPr: false, idempotencyKey: "k1", startedBy: "admin", createdAt: "x" };
    });
    const runDir = path.join(wsDir, ".graph-execution", runId);
    await mkdir(runDir, { recursive: true });
    const state = stateSchema.parse({
      runId,
      provider: "fake",
      startingCommit: "0".repeat(40),
      integrationBranch: `graph/${runId}`,
      tasks: {},
      review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "awaiting-approval",
      plan: { contentPath: "x", refs: [{ ref: "A" }], gate: true, name: "hello", attempts: 1, questions: [], dropped: [], feedback: [] },
    });
    await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));

    const res = await post(t, { content: "x", provider: "fake", sandbox: false, idempotencyKey: "k1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId, workspace: WS, status: "awaiting-approval", refs: [{ ref: "A" }] });

    // The same key in another workspace is not matched: that one goes on to start (and fails on the provider here).
    await gitInit("gitlab", "grp", "proj");
    const other = await post(t, { content: "x", sandbox: false, idempotencyKey: "k1" }, `/api/v1/workspaces/${WS2}/runs`);
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({ error: NO_PROVIDER });
  });
});

/** Whether the built engine has `--refs` (an engine slice of the same spec adds it; until it lands, start without refs). */
async function engineHasRefs(): Promise<boolean> {
  const help = await execa(process.execPath, [BIN, "--help"], { reject: false });
  return help.stdout.includes("--refs");
}

describe.skipIf(!built)("POST /api/v1/workspaces/:ws/runs with the built engine", () => {
  it("starts a run from content that plans and stops at awaiting-approval; the same key answers the same run", async () => {
    await setup({ graphExecutionBin: BIN });
    const { id: tokenId, token: t } = await token(["runs:start", "runs:read"]);
    const content = "# Add hello\n\nWrite hello.txt\n";
    const withRefs = await engineHasRefs();
    const refs = withRefs ? [{ ref: "A", url: "https://t/A" }] : [];
    const res = await post(t, { content, ...(withRefs ? { refs } : {}), provider: "fake", sandbox: false, idempotencyKey: "k2" });
    const created = res.json<{ runId: string; viewUrl: string; error?: string }>();
    expect(res.statusCode, created.error).toBe(201);
    const { runId } = created;
    expect(runId).toMatch(/^gm-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(created.viewUrl).toBe(`/runs/${WS}/${runId}`);
    const runDir = path.join(wsDir, ".graph-execution", runId);
    const web = JSON.parse(await readFile(path.join(runDir, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
    if (web.pid) started.push(web.pid);

    const inputs = inputsDirOf(ctx!.config.dataDir, runId);
    expect(await readFile(path.join(inputs, "content.md"), "utf8")).toBe(content);
    if (withRefs) expect(JSON.parse(await readFile(path.join(inputs, "refs.json"), "utf8"))).toEqual(refs);
    else expect(existsSync(path.join(inputs, "refs.json"))).toBe(false);
    expect(ctx!.store.get().apiRuns[`${WS}/${runId}`]).toMatchObject({ refs, openPr: false, idempotencyKey: "k2", startedBy: tokenId });
    // An API start leaves the UI's remembered choices alone.
    expect(ctx!.store.get().runDefaults[WS]).toBeUndefined();
    expect(ctx!.store.get().workspaceSettings[WS]?.sandbox).toBeUndefined();

    const seen = new Set<string>();
    const run = await poll("the run to await approval", async () => {
      const r = await ctx!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: bearer(t) });
      if (r.statusCode !== 200) return undefined;
      const body = r.json<{ status: string; refs: unknown; spec?: string }>();
      seen.add(body.status);
      return body.status === "awaiting-approval" ? body : undefined;
    });
    expect([...seen].every((s) => s === "planning" || s === "awaiting-approval")).toBe(true);
    expect(run.refs).toEqual(refs);
    expect(run.spec).toMatch(/^docs\/prd\/.+\.md$/);
    const web2 = JSON.parse(await readFile(path.join(runDir, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
    if (web2.pid) started.push(web2.pid);

    const again = await post(t, { content, provider: "fake", sandbox: false, idempotencyKey: "k2" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ runId, status: "awaiting-approval" });
  }, 90_000);
});

describe("POST /api/v1/workspaces/:ws/runs in a sandbox", () => {
  let fake: FakeDocker;
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
      await (this as unknown as { docker: { createVolume(n: string): Promise<unknown> } }).docker.createVolume("gm-clis-test");
      return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx?.cleanup();
    ctx = undefined;
    await fake.close();
  });

  it("copies the inputs into the run's folder in the workspace and passes that path (sandbox is the default)", async () => {
    await setup({ dockerSocket: fake.socketPath, sandboxImage: "img:default" });
    const { token: t } = await token(["runs:start"]);
    const content = "# Add hello\n";
    const res = await post(t, { content, provider: "fake", refs: [{ ref: "A" }] });
    const created = res.json<{ runId: string; viewUrl: string; error?: string }>();
    expect(res.statusCode, created.error).toBe(201);
    const { runId } = created;
    expect(created.viewUrl).toBe(`/runs/${WS}/${runId}`);

    const all = [...fake.containers.values()];
    expect(all).toHaveLength(1);
    const cmd = all[0]!.Config.Cmd;
    const rel = `.graph-execution/${runId}/inputs/content.md`;
    expect(cmd[cmd.indexOf("--content") + 1]).toBe(rel);
    expect(cmd[cmd.indexOf("--refs") + 1]).toBe(`.graph-execution/${runId}/inputs/refs.json`);
    expect(cmd).not.toContain("--web");
    expect(await readFile(path.join(wsDir, rel), "utf8")).toBe(content);
    expect(await readFile(path.join(inputsDirOf(ctx!.config.dataDir, runId), "content.md"), "utf8")).toBe(content);
    // The UI's "Run in sandbox" choice stays the human's.
    expect(ctx!.store.get().workspaceSettings[WS]?.sandbox).toBeUndefined();
  });
});
