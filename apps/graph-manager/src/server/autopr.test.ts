// The auto-PR loop (docs/prd/automation-api.md): an applied API run with openPr gets its PR once; a failure is kept.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../scripts/fake-forge.mjs";
import { appWithLogin } from "./test-helpers.js";

const WS = "github~octo~hello";
const ID = "gm-20261106-100000-abcd";
const KEY = `${WS}/${ID}`;

let forge: FakeForge;
let ctx: Awaited<ReturnType<typeof appWithLogin>>;

beforeEach(async () => {
  forge = await startFakeForge();
  ctx = await appWithLogin({ githubApiUrl: `${forge.url}/github` }, { autoPrMs: 50 });
});

afterEach(async () => {
  await ctx.cleanup();
  await forge.close();
});

const req = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => ctx.app.inject({ method, url, payload, headers: { cookie: ctx.cookie } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<void> {
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
}

async function poll<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(30);
  }
}

/** Clones octo/hello (needs a connected forge), writes a run with `status` and a changed file; returns the checkout. */
async function cloneWithRun(runId: string, status: string): Promise<string> {
  const res = await req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" });
  expect(res.statusCode).toBe(202);
  const id = res.json<{ job: { id: string } }>().job.id;
  await poll("the clone", async () => {
    const jobs = (await req("GET", "/api/workspaces/clones")).json<{ jobs: { id: string; status: string; error?: string }[] }>();
    const job = jobs.jobs.find((j) => j.id === id);
    if (job?.status === "failed") throw new Error(`clone failed: ${job.error ?? ""}`);
    return job?.status === "done" ? true : undefined;
  });
  const dest = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await writeRun(dest, runId, status);
  return dest;
}

async function writeRun(dest: string, runId: string, status: string): Promise<void> {
  const runDir = path.join(dest, ".graph-execution", runId);
  const tasksDir = path.join(runDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, "1.json"), JSON.stringify({ id: "1", content: "# Say hello\n\nWrite hello.txt.", dependencies: [] }));
  const specPath = path.join(runDir, "spec.md");
  await writeFile(specPath, "# Hello feature\n\nBody.\n");
  const state = stateSchema.parse({
    runId,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${runId}`,
    specPath,
    tasksDir,
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "merged", attempts: 1 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-06T10:00:00.000Z",
    status,
  });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
  await writeFile(path.join(dest, "hello.txt"), "hello\n");
}

async function seed(key: string, openPr: boolean): Promise<void> {
  await ctx.store.update((d) => {
    d.apiRuns[key] = { refs: [], openPr, startedBy: "admin", createdAt: "x" };
  });
}

const listen = () => ctx.app.listen({ port: 0, host: "127.0.0.1" });

describe("the auto-PR loop", () => {
  it("opens the PR of an applied API run with openPr, without a click", async () => {
    await connect();
    await cloneWithRun(ID, "applied");
    await seed(KEY, true);
    await listen();
    const pr = await poll("the PR", () => ctx.store.get().prs[KEY]);
    expect(pr.branch).toBe(`gm/${ID}`);
    expect(ctx.store.get().apiRuns[KEY]).toMatchObject({ prAttempted: true });
    expect(ctx.store.get().apiRuns[KEY]?.prError).toBeUndefined();
    const run = await req("GET", `/api/v1/runs/${ID}`);
    expect(run.json<{ pr?: { url: string } }>().pr?.url).toBe(pr.url);
  });

  it("keeps a failure as prError and does not try again", async () => {
    await connect();
    await cloneWithRun(ID, "applied");
    // Not connected when the loop looks at the run.
    await ctx.app.inject({ method: "DELETE", url: "/api/forges/github", headers: { cookie: ctx.cookie } });
    expect(ctx.store.get().forges.github).toBeUndefined();
    await seed(KEY, true);
    await listen();
    const prError = await poll("prError", () => ctx.store.get().apiRuns[KEY]?.prError);
    expect(prError).toContain("not connected");
    expect(ctx.store.get().apiRuns[KEY]?.prAttempted).toBe(true);

    await connect();
    await sleep(400);
    expect(ctx.store.get().prs[KEY]).toBeUndefined();
    expect(ctx.store.get().apiRuns[KEY]?.prError).toBe(prError);

    const run = await req("GET", `/api/v1/runs/${ID}`);
    expect(run.json()).toMatchObject({ status: "applied", prError });
    const list = await req("GET", "/api/runs");
    const summary = list.json<{ runs: { id: string; prError?: string }[] }>().runs.find((r) => r.id === ID);
    expect(summary?.prError).toBe(prError);
  });

  it("leaves alone an entry without openPr and a run that has not landed", async () => {
    await connect();
    const dest = await cloneWithRun(ID, "applied");
    const other = "gm-20261106-100001-abcd";
    await writeRun(dest, other, "awaiting-approval");
    await seed(KEY, false);
    await seed(`${WS}/${other}`, true);
    await listen();
    await sleep(400);
    expect(ctx.store.get().prs).toEqual({});
    expect(ctx.store.get().apiRuns[KEY]?.prAttempted).toBeUndefined();
    expect(ctx.store.get().apiRuns[`${WS}/${other}`]?.prAttempted).toBeUndefined();
    expect(ctx.store.get().apiRuns[`${WS}/${other}`]?.prError).toBeUndefined();
  });

  it("stops looking at a run that ended needs-info or whose folder is gone", async () => {
    await connect();
    const dest = await cloneWithRun(ID, "needs-info");
    const gone = "gm-20261106-100002-abcd";
    const failed = "gm-20261106-100003-abcd";
    await writeRun(dest, failed, "failed");
    await seed(KEY, true);
    await seed(`${WS}/${gone}`, true);
    await seed(`${WS}/${failed}`, true);
    await listen();
    expect(await poll("the needs-info run skipped", () => ctx.store.get().apiRuns[KEY]?.prSkipped)).toBe("the run ended needs-info");
    expect(await poll("the gone run skipped", () => ctx.store.get().apiRuns[`${WS}/${gone}`]?.prSkipped)).toBe("the run folder is gone");
    // A failed run may still be resumed to applied: it stays.
    expect(ctx.store.get().apiRuns[`${WS}/${failed}`]?.prSkipped).toBeUndefined();
    expect(ctx.store.get().apiRuns[KEY]?.prAttempted).toBeUndefined();
    expect(ctx.store.get().prs).toEqual({});
  });
});
