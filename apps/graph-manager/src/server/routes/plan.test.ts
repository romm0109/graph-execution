import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appWithLogin } from "../test-helpers.js";

const WS = "github~octo~hello";
const RUN = "gm-20261113-100000-aaaa";

let ctx: Awaited<ReturnType<typeof appWithLogin>>;
let wsDir: string;

const g = (args: string[]) => execa("git", args, { cwd: wsDir });

async function get(url: string, cookie = true): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({ method: "GET", url, headers: cookie ? { cookie: ctx.cookie } : {} });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

async function writeRun(runId: string, plan: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Promise<void> {
  const runDir = path.join(wsDir, ".graph-execution", runId);
  await mkdir(runDir, { recursive: true });
  const state = stateSchema.parse({
    runId,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${runId}`,
    specPath: path.join(wsDir, "docs", "prd", "hello-feature.md"),
    tasksDir: path.join(wsDir, ".agents", "tasks", "hello-feature"),
    hashes: { config: "", tasks: "", spec: "" },
    tasks: {},
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-13T10:00:00.000Z",
    status: "awaiting-approval",
    ...(plan ? { plan } : {}),
    ...extra,
  });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
}

const PLAN = { contentPath: "x", refs: [{ ref: "A" }], gate: true, name: "hello-feature", attempts: 1, questions: [], dropped: [], feedback: [] };

beforeEach(async () => {
  ctx = await appWithLogin();
  wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  await g(["init", "-q", "-b", "main"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "t"]);
  await writeFile(path.join(wsDir, "README.md"), "hi\n");
  await writeFile(path.join(wsDir, ".gitignore"), ".graph-execution/\n");
  await g(["add", "."]);
  await g(["commit", "-q", "-m", "init"]);
  await g(["checkout", "-q", "-b", `graph/${RUN}`]);
  await mkdir(path.join(wsDir, "docs", "prd"), { recursive: true });
  await mkdir(path.join(wsDir, ".agents", "tasks", "hello-feature"), { recursive: true });
  await writeFile(path.join(wsDir, "docs", "prd", "hello-feature.md"), "# Hello feature\n\nBody\n");
  await writeFile(
    path.join(wsDir, ".agents", "tasks", "hello-feature", "1.json"),
    JSON.stringify({ id: "1", content: "# Say hello\n\nWrite hello.txt", dependencies: [] }),
  );
  await writeFile(path.join(wsDir, ".agents", "tasks", "hello-feature", "test-plan.json"), JSON.stringify({ checks: [] }));
  await g(["add", "."]);
  await g(["commit", "-q", "-m", "Plan: hello-feature"]);
  await g(["checkout", "-q", "main"]);
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("GET /api/runs/:ws/:runId/plan", () => {
  it("returns the spec and tasks committed on the integration branch", async () => {
    await writeRun(RUN, PLAN);
    expect(existsSync(path.join(wsDir, "docs", "prd", "hello-feature.md"))).toBe(false);
    const res = await get(`/api/runs/${WS}/${RUN}/plan`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const spec = res.body.spec as { path: string; title: string; text: string };
    expect(spec.path).toBe("docs/prd/hello-feature.md");
    expect(spec.title).toBe("Hello feature");
    expect(spec.text).toContain("Body");
    expect(res.body.name).toBe("hello-feature");
    expect(res.body.tasks).toEqual([{ id: "1", title: "Say hello" }]);
    expect(res.body.refs).toEqual([{ ref: "A" }]);
    expect(res.body.feedback).toEqual([]);
  });

  it("reads the integration worktree when the branch is gone", async () => {
    const other = "gm-20261113-110000-bbbb";
    await writeRun(other, PLAN);
    const wt = path.join(wsDir, ".graph-execution", other, "worktrees", "integration");
    await mkdir(path.join(wt, "docs", "prd"), { recursive: true });
    await mkdir(path.join(wt, ".agents", "tasks", "hello-feature"), { recursive: true });
    await writeFile(path.join(wt, "docs", "prd", "hello-feature.md"), "# From worktree\n");
    await writeFile(path.join(wt, ".agents", "tasks", "hello-feature", "2.json"), "not json");
    const res = await get(`/api/runs/${WS}/${other}/plan`);
    expect(res.status).toBe(200);
    expect((res.body.spec as { title: string }).title).toBe("From worktree");
    expect(res.body.tasks).toEqual([{ id: "2", title: "2" }]);
  });

  it("never reads a spec or task folder outside the workspace that state.json points to", async () => {
    const outside = path.join(ctx.config.dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.md"), "# Secret\n");
    await writeFile(path.join(outside, "1.json"), JSON.stringify({ id: "1", content: "# Secret task" }));
    await writeRun(RUN, { ...PLAN, name: "not-on-branch" }, { specPath: path.join(outside, "secret.md"), tasksDir: outside });
    const res = await get(`/api/runs/${WS}/${RUN}/plan`);
    expect(res.status).toBe(200);
    expect(res.body.spec).toBeNull();
    expect(res.body.tasks).toEqual([]);
    // A symlink inside the workspace that points outside is refused too (symlinks need privileges on Windows).
    if (process.platform === "win32") return;
    await symlink(path.join(outside, "secret.md"), path.join(wsDir, "link.md"));
    await writeRun(RUN, { ...PLAN, name: "not-on-branch" }, { specPath: path.join(wsDir, "link.md") });
    expect((await get(`/api/runs/${WS}/${RUN}/plan`)).body.spec).toBeNull();
  });

  it("404s without a valid plan name or run, 401s without the cookie", async () => {
    await writeRun(RUN, { ...PLAN, name: undefined });
    expect((await get(`/api/runs/${WS}/${RUN}/plan`)).body).toEqual({ error: "the run has no plan" });
    expect((await get(`/api/runs/${WS}/${RUN}/plan`)).status).toBe(404);
    await writeRun(RUN, { ...PLAN, name: "../x" });
    expect((await get(`/api/runs/${WS}/${RUN}/plan`)).status).toBe(404);
    expect((await get(`/api/runs/${WS}/gm-20261113-120000-cccc/plan`)).status).toBe(404);
    expect((await get(`/api/runs/github~octo~missing/${RUN}/plan`)).status).toBe(404);
    expect((await get(`/api/runs/${WS}/${RUN}/plan`, false)).status).toBe(401);
  });
});
