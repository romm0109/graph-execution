// The read half of /api/v1 (docs/prd/automation-api.md): run objects, GET runs, GET run, GET workspaces.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appWithLogin } from "../test-helpers.js";

const WS = "github~octo~hello";
const WS2 = "gitlab~grp~sub~proj";

let ctx: Awaited<ReturnType<typeof appWithLogin>>;
let wsDir: string;
let ws2Dir: string;

const bearer = (t: string) => ({ authorization: "Bearer " + t });

async function token(scopes: string[]): Promise<string> {
  const res = await ctx.app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: ctx.cookie }, payload: { name: "t", scopes } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

async function gitInit(...parts: string[]): Promise<string> {
  const dir = path.join(ctx.config.workspacesDir, ...parts);
  await mkdir(dir, { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

async function writeRun(dir: string, runId: string, extra: Record<string, unknown>): Promise<void> {
  const runDir = path.join(dir, ".graph-execution", runId);
  await mkdir(runDir, { recursive: true });
  const state = stateSchema.parse({
    runId,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${runId}`,
    tasks: {},
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-06T10:00:00.000Z",
    ...extra,
  });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
}

const PLAN = {
  contentPath: "x",
  refs: [{ ref: "A", url: "https://t/A" }, { ref: "B" }],
  gate: true,
  name: "hello-feature",
  attempts: 1,
  questions: [{ ref: "B", questions: ["Which color?"] }],
  dropped: ["B"],
  feedback: [],
};

const AWAITING = "gm-20261106-100000-aaaa";
const PLAN_FAILED = "gm-20261106-110000-bbbb";
const TASK_FAILED = "gm-20261106-120000-cccc";
const APPLIED = "gm-20261106-130000-dddd";
const DEAD = "gm-20261106-140000-eeee";
const OTHER = "gm-20261106-150000-ffff";

beforeEach(async () => {
  ctx = await appWithLogin();
  wsDir = await gitInit("github", "octo", "hello");
  ws2Dir = await gitInit("gitlab", "grp", "sub", "proj");
  await writeRun(wsDir, AWAITING, { status: "awaiting-approval", plan: PLAN, createdAt: "2026-11-06T10:00:00.000Z" });
  await writeRun(wsDir, PLAN_FAILED, {
    status: "failed",
    plan: { ...PLAN, refs: [{ ref: "C" }], questions: [], dropped: [], name: undefined, error: "bad tasks" },
    createdAt: "2026-11-06T11:00:00.000Z",
  });
  await writeRun(wsDir, TASK_FAILED, {
    status: "failed",
    specPath: path.join(wsDir, "docs", "spec.md"),
    tasksDir: path.join(wsDir, "tasks"),
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "failed", attempts: 2 } },
    createdAt: "2026-11-06T12:00:00.000Z",
  });
  await writeRun(wsDir, APPLIED, { status: "applied", plan: { ...PLAN, refs: [{ ref: "A" }] }, createdAt: "2026-11-06T13:00:00.000Z" });
  await writeRun(wsDir, DEAD, { status: "running", createdAt: "2026-11-06T14:00:00.000Z" });
  await writeRun(ws2Dir, OTHER, { status: "failed", plan: { ...PLAN, refs: [{ ref: "A" }], error: "x" }, createdAt: "2026-11-06T15:00:00.000Z" });
  // A suite folder: never part of v1.
  await mkdir(path.join(wsDir, ".graph-execution", "suite-20261106-160000-abcd"), { recursive: true });
  await writeFile(path.join(wsDir, ".graph-execution", "suite-20261106-160000-abcd", "suite.json"), "{}");
});

afterEach(async () => {
  await ctx.cleanup();
});

const get = (url: string, headers: Record<string, string>) => ctx.app.inject({ method: "GET", url, headers });

describe("GET /api/v1/runs/:id", () => {
  it("returns the run object of a planned run awaiting approval", async () => {
    const t = await token(["runs:read"]);
    const res = await get(`/api/v1/runs/${AWAITING}`, bearer(t));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      runId: AWAITING,
      workspace: WS,
      status: "awaiting-approval",
      refs: [{ ref: "A", url: "https://t/A" }, { ref: "B" }],
      questions: [{ ref: "B", questions: ["Which color?"] }],
      dropped: ["B"],
      spec: "docs/prd/hello-feature.md",
      tasksDir: ".agents/tasks/hello-feature",
      viewUrl: `/runs/${WS}/${AWAITING}`,
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: expect.any(String),
    });
  });

  it("explains a failed run, and leaves error out otherwise", async () => {
    const t = await token(["runs:read"]);
    const planFailed = (await get(`/api/v1/runs/${PLAN_FAILED}`, bearer(t))).json() as Record<string, unknown>;
    expect(planFailed).toMatchObject({ status: "failed", error: "planning failed: bad tasks" });
    expect(planFailed).not.toHaveProperty("spec");

    const taskFailed = (await get(`/api/v1/runs/${TASK_FAILED}`, bearer(t))).json() as Record<string, unknown>;
    expect(taskFailed).toMatchObject({ status: "failed", error: "task 1 failed", spec: "docs/spec.md", tasksDir: "tasks", refs: [] });

    await ctx.store.update((d) => {
      d.prs[`${WS}/${APPLIED}`] = { url: "https://github.com/octo/hello/pull/7", number: 7, branch: "b", forge: "github", createdAt: "2026-11-06T13:30:00.000Z" };
    });
    const applied = (await get(`/api/v1/runs/${APPLIED}`, bearer(t))).json() as Record<string, unknown>;
    expect(applied.status).toBe("applied");
    expect(applied).not.toHaveProperty("error");
    expect(applied.pr).toEqual({ url: "https://github.com/octo/hello/pull/7", number: 7 });
  });

  it("reports a running run without a process as failed (interrupted)", async () => {
    const t = await token(["runs:read"]);
    const body = (await get(`/api/v1/runs/${DEAD}`, bearer(t))).json() as { status: string; error: string };
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/^interrupted/);
  });

  it("answers 404 for an unknown run and for a suite", async () => {
    const t = await token(["runs:read"]);
    for (const id of ["gm-20990101-000000-ffff", "suite-20261106-160000-abcd", "..%2Fx"]) {
      const res = await get(`/api/v1/runs/${id}`, bearer(t));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "unknown run" });
    }
  });
});

describe("GET /api/v1/runs", () => {
  const ids = async (query: string, t: string) => {
    const res = await get(`/api/v1/runs${query}`, bearer(t));
    expect(res.statusCode).toBe(200);
    return (res.json() as { runs: { runId: string }[] }).runs.map((r) => r.runId);
  };

  it("lists every run newest first, without suites", async () => {
    const t = await token(["runs:read"]);
    expect(await ids("", t)).toEqual([OTHER, DEAD, APPLIED, TASK_FAILED, PLAN_FAILED, AWAITING]);
  });

  it("filters by status, ref and workspace, ANDed", async () => {
    const t = await token(["runs:read"]);
    expect(await ids("?status=failed", t)).toEqual([OTHER, DEAD, TASK_FAILED, PLAN_FAILED]);
    expect(await ids("?ref=A", t)).toEqual([OTHER, APPLIED, AWAITING]);
    expect(await ids(`?workspace=${WS2}`, t)).toEqual([OTHER]);
    expect(await ids(`?workspace=${WS}&ref=A`, t)).toEqual([APPLIED, AWAITING]);
    expect(await ids(`?workspace=${WS}&ref=A&status=applied`, t)).toEqual([APPLIED]);
    expect(await ids("?ref=nope", t)).toEqual([]);
  });

  it("rejects a bad status (400) and an unknown workspace (404)", async () => {
    const t = await token(["runs:read"]);
    expect((await get("/api/v1/runs?status=bogus", bearer(t))).statusCode).toBe(400);
    const res = await get("/api/v1/runs?workspace=github~octo~nope", bearer(t));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "unknown workspace" });
  });
});

describe("GET /api/v1/workspaces", () => {
  it("lists workspaces with owner, repo and the default provider", async () => {
    const t = await token(["workspaces:read"]);
    expect((await get("/api/v1/workspaces", bearer(t))).json()).toEqual({
      workspaces: [
        { id: WS, forge: "github", owner: "octo", repo: "hello" },
        { id: WS2, forge: "gitlab", owner: "grp/sub", repo: "proj" },
      ],
    });
    await ctx.store.update((d) => {
      d.runDefaults[WS] = { provider: "fake", tasksDir: "t", spec: "s.md", options: {} };
    });
    const body = (await get("/api/v1/workspaces", bearer(t))).json() as { workspaces: { id: string; defaultProvider?: string }[] };
    expect(body.workspaces.find((w) => w.id === WS)?.defaultProvider).toBe("fake");
  });
});

describe("scopes", () => {
  it("guards the run reads with runs:read and the workspace list with workspaces:read", async () => {
    const wsOnly = await token(["workspaces:read"]);
    const runsOnly = await token(["runs:read"]);
    for (const url of ["/api/v1/runs", `/api/v1/runs/${AWAITING}`]) {
      const res = await get(url, bearer(wsOnly));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "missing scope runs:read" });
    }
    const res = await get("/api/v1/workspaces", bearer(runsOnly));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "missing scope workspaces:read" });
    expect((await get("/api/v1/runs", {})).statusCode).toBe(401);
    expect((await get("/api/v1/workspaces", {})).statusCode).toBe(401);
    expect((await get("/api/v1/runs", { cookie: ctx.cookie })).statusCode).toBe(200);
    expect((await get("/api/v1/workspaces", { cookie: ctx.cookie })).statusCode).toBe(200);
  });
});
