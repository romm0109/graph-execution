// /api/v1 run actions (docs/prd/automation-api.md): approve, reject, resume, abort, pr; and the UI's cookie routes.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGraphExecutionBin } from "../config.js";
import { inputsDirOf } from "../inputs.js";
import { appWithLogin } from "../test-helpers.js";

const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
if (!built) console.warn(`skipping the v1 run-action tests with the engine: ${BIN} is missing; run \`npm run build -w graph-execution\` first`);

const WS = "github~octo~hello";
const ID = "gm-20260101-000000-abcd";

let ctx: Awaited<ReturnType<typeof appWithLogin>> | undefined;
let wsDir: string;
/** PIDs of run processes this test started, stopped in afterEach if still alive. */
let started: number[];

const bearer = (t: string) => ({ authorization: "Bearer " + t });

async function token(scopes: string[]): Promise<string> {
  const res = await ctx!.app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: ctx!.cookie }, payload: { name: "t", scopes } });
  expect(res.statusCode).toBe(201);
  return res.json<{ token: string }>().token;
}

async function setup(overrides: Parameters<typeof appWithLogin>[0] = {}): Promise<void> {
  ctx = await appWithLogin(overrides);
  wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  const git = (...args: string[]) => execa("git", args, { cwd: wsDir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@example.com");
  await writeFile(path.join(wsDir, "README.md"), "# hello\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
}

async function writeState(status: string, runId = ID): Promise<void> {
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
    status,
    plan: { contentPath: "x", refs: [], gate: true, name: "hello", attempts: 1, questions: [], dropped: [], feedback: [] },
  });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
}

function post(auth: { authorization: string } | { cookie: string }, url: string, payload?: unknown) {
  return ctx!.app.inject({ method: "POST", url, headers: auth, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
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
  vi.unstubAllEnvs();
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

describe("/api/v1 run actions: refusals", () => {
  let t: string;
  beforeEach(async () => {
    await setup();
    t = await token(["runs:approve", "runs:control", "runs:pr", "runs:read"]);
  });

  it.each([["applied"], ["failed"]])("approve of a %s run answers 409", async (status) => {
    await writeState(status);
    const res = await post(bearer(t), `/api/v1/runs/${ID}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: `the run is not awaiting approval (status ${status})` });
  });

  it("reject with a blank feedback answers 400; of a running run 409", async () => {
    await writeState("awaiting-approval");
    const blank = await post(bearer(t), `/api/v1/runs/${ID}/reject`, { feedback: "  " });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toEqual({ error: "feedback: feedback is required" });
    await writeState("running");
    const res = await post(bearer(t), `/api/v1/runs/${ID}/reject`, { feedback: "Use blue" });
    expect(res.statusCode).toBe(409);
    // A "running" run with no process is interrupted: v1 maps it to failed.
    expect(res.json<{ error: string }>().error).toMatch(/^the run is not awaiting approval \(status /);
    const inputs = inputsDirOf(ctx!.config.dataDir, ID);
    expect(existsSync(inputs) ? (await readdir(inputs)).filter((n) => n.startsWith("feedback-")) : []).toEqual([]);
  });

  it.each([["applied"], ["awaiting-approval"]])("resume of a %s run answers 409", async (status) => {
    await writeState(status);
    const res = await post(bearer(t), `/api/v1/runs/${ID}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: `the run can't be resumed (status ${status})` });
  });

  it("abort of a run that is not live answers 409", async () => {
    await writeState("failed");
    const res = await post(bearer(t), `/api/v1/runs/${ID}/abort`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "the run is not live" });
  });

  it("pr of a failed run answers 409", async () => {
    await writeState("failed");
    const res = await post(bearer(t), `/api/v1/runs/${ID}/pr`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "the run has not landed (status failed)" });
  });

  it("pr of an applied run without changes answers 409 with the reason", async () => {
    await writeState("applied");
    const res = await post(bearer(t), `/api/v1/runs/${ID}/pr`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "no uncommitted changes in the workspace" });
  });

  it.each([
    ["approve", "runs:approve"],
    ["reject", "runs:approve"],
    ["resume", "runs:control"],
    ["abort", "runs:control"],
    ["pr", "runs:pr"],
  ])("%s needs %s", async (action, scope) => {
    await writeState("awaiting-approval");
    const reader = await token(["runs:read"]);
    const res = await post(bearer(reader), `/api/v1/runs/${ID}/${action}`, action === "reject" ? { feedback: "x" } : undefined);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: `missing scope ${scope}` });
  });

  it.each([["approve"], ["reject"], ["resume"], ["abort"], ["pr"]])("%s of an unknown or invalid id answers 404", async (action) => {
    const payload = action === "reject" ? { feedback: "x" } : undefined;
    for (const id of ["gm-20260101-000000-ffff", "nope"]) {
      const res = await post(bearer(t), `/api/v1/runs/${id}/${action}`, payload);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "unknown run" });
    }
  });

  it("the cookie routes answer the same", async () => {
    const cookie = { cookie: ctx!.cookie };
    await writeState("applied");
    const approve = await post(cookie, `/api/runs/${WS}/${ID}/approve`);
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toEqual({ error: "the run is not awaiting approval (status applied)" });
    const reject = await post(cookie, `/api/runs/${WS}/${ID}/reject`, { feedback: "x" });
    expect(reject.statusCode).toBe(409);
    expect(reject.json()).toEqual({ error: "the run is not awaiting approval (status applied)" });
    const blank = await post(cookie, `/api/runs/${WS}/${ID}/reject`, { feedback: " " });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toEqual({ error: "feedback: feedback is required" });
    expect((await post(cookie, `/api/runs/github~octo~nope/${ID}/approve`)).json()).toEqual({ error: "unknown workspace" });
    expect((await post(cookie, `/api/runs/${WS}/gm-20260101-000000-ffff/approve`)).statusCode).toBe(404);
  });
});

describe.skipIf(!built)("/api/v1 run actions with the built engine", () => {
  const pidOf = async (runId: string) => {
    const web = JSON.parse(await readFile(path.join(wsDir, ".graph-execution", runId, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
    if (web.pid && !started.includes(web.pid)) started.push(web.pid);
  };
  const runOf = async (t: string, runId: string) => {
    const r = await ctx!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: bearer(t) });
    return r.statusCode === 200 ? r.json<{ status: string }>() : undefined;
  };
  const waitStatus = (t: string, runId: string, status: string, timeoutMs = 60_000) =>
    poll(`the run to be ${status}`, async () => {
      await pidOf(runId);
      const run = await runOf(t, runId);
      return run?.status === status ? run : undefined;
    }, timeoutMs);
  const readState = async (runId: string) => stateSchema.parse(JSON.parse(await readFile(path.join(wsDir, ".graph-execution", runId, "state.json"), "utf8")));

  it("reject plans again with the feedback; approve runs the plan to applied", async () => {
    await setup({ graphExecutionBin: BIN });
    const t = await token(["runs:start", "runs:read", "runs:approve"]);
    const res = await post(bearer(t), `/api/v1/workspaces/${WS}/runs`, { content: "# Add hello\n\nWrite hello.txt\n", provider: "fake", sandbox: false });
    const created = res.json<{ runId: string; error?: string }>();
    expect(res.statusCode, created.error).toBe(201);
    const { runId } = created;
    await waitStatus(t, runId, "awaiting-approval");

    const rejected = await post(bearer(t), `/api/v1/runs/${runId}/reject`, { feedback: "Use blue" });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ runId });
    const fbDir = inputsDirOf(ctx!.config.dataDir, runId);
    const fbFiles = (await readdir(fbDir)).filter((n) => /^feedback-\d+-[0-9a-f]{6}\.md$/.test(n));
    expect(fbFiles).toHaveLength(1);
    expect(await readFile(path.join(fbDir, fbFiles[0]!), "utf8")).toBe("Use blue");
    await poll("the run to plan again with the feedback", async () => {
      await pidOf(runId);
      const run = await runOf(t, runId);
      if (run?.status !== "awaiting-approval") return undefined;
      const state = await readState(runId);
      return state.plan?.feedback.some((f) => f.includes("Use blue")) ? true : undefined;
    });

    const approved = await post(bearer(t), `/api/v1/runs/${runId}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);
    await waitStatus(t, runId, "applied", 90_000);
    const again = await post(bearer(t), `/api/v1/runs/${runId}/approve`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "the run is not awaiting approval (status applied)" });
    await ctx!.app.inject({ method: "POST", url: `/runs/${WS}/${runId}/view/close`, headers: { cookie: ctx!.cookie } });
  }, 180_000);

  it("abort of a live run ends it aborted", async () => {
    await setup({ graphExecutionBin: BIN });
    // Outside the repo: the fake planner names task 1, which hangs until the abort.
    const scriptFile = path.join(path.dirname(wsDir), "fake.json");
    await writeFile(scriptFile, JSON.stringify({ "task:1": { attempts: [{ hang: true }] } }));
    vi.stubEnv("GRAPH_EXECUTION_FAKE_SCRIPT", scriptFile);
    const t = await token(["runs:start", "runs:read", "runs:control"]);
    const res = await post(bearer(t), `/api/v1/workspaces/${WS}/runs`, {
      content: "# Add hello\n\nWrite hello.txt\n",
      provider: "fake",
      sandbox: false,
      gate: "auto",
    });
    const created = res.json<{ runId: string; error?: string }>();
    expect(res.statusCode, created.error).toBe(201);
    const { runId } = created;
    await poll("the task to run", async () => {
      await pidOf(runId);
      const run = await runOf(t, runId);
      if (run?.status !== "running") return undefined;
      const state = await readState(runId).catch(() => undefined);
      return state && Object.values(state.tasks).some((x) => x.status === "running") ? true : undefined;
    });
    const aborted = await post(bearer(t), `/api/v1/runs/${runId}/abort`);
    expect(aborted.statusCode, aborted.body).toBe(200);
    await waitStatus(t, runId, "aborted");
    await ctx!.app.inject({ method: "POST", url: `/runs/${WS}/${runId}/view/close`, headers: { cookie: ctx!.cookie } });
  }, 120_000);
});
