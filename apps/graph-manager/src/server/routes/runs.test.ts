import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { defaultGraphExecutionBin } from "../config.js";
import type { RunSummary } from "../runs.js";
import { appWithLogin, tempDir, testConfig } from "../test-helpers.js";
import { engineCommand, newRunId } from "./runs.js";

const FIXTURES = fileURLToPath(new URL("../../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
if (!built) console.warn(`skipping the start-run test: ${BIN} is missing; run \`npm run build -w graph-execution\` first`);

const WS = "github~octo~hello";

let dir: string;
let cleanup: () => Promise<void>;
let wsDir: string;
let app: FastifyInstance;
let base: string;
let cookie: string;
/** PIDs of run processes this test started, stopped in afterEach if still alive. */
let started: number[];

async function git(...args: string[]): Promise<void> {
  await execa("git", args, { cwd: wsDir });
}

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

beforeEach(async () => {
  started = [];
  ({ dir, cleanup } = await tempDir());
  wsDir = path.join(dir, "ws", "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@example.com");
  await cp(path.join(FIXTURES, "diamond"), path.join(wsDir, "diamond"), { recursive: true });
  await cp(path.join(FIXTURES, "spec.md"), path.join(wsDir, "spec.md"));
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  await writeFile(path.join(dir, "outside.md"), "# outside");

  app = await buildApp(testConfig(dir, { graphExecutionBin: BIN }), { webDir: path.join(dir, "no-web"), viewCache: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw" }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  await app.close();
  await cleanup();
});

describe("runs API", () => {
  it("rejects paths outside the workspace or missing ones with 400", async () => {
    const outside = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "../../../../outside.md", provider: "fake" });
    expect(outside.status).toBe(400);
    const missing = await api("POST", `/api/runs/${WS}`, { tasksDir: "nope", spec: "spec.md", provider: "fake" });
    expect(missing.status).toBe(400);
    const absolute = await api("POST", `/api/runs/${WS}`, { tasksDir: path.join(wsDir, "diamond"), spec: "spec.md", provider: "fake" });
    expect(absolute.status).toBe(400);
    const badProvider = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "gpt" });
    expect(badProvider.status).toBe(400);
  });

  it.skipIf(!built)("answers 400 with the exit code and output when graph-execution fails to start", async () => {
    await writeFile(path.join(wsDir, "diamond", "1.json"), "{ not json");
    const res = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "fake" });
    const body = (await res.json()) as { error: string; exitCode?: number; output?: string };
    expect(res.status).toBe(400);
    expect(body.exitCode).toBeGreaterThan(0);
    expect(body.output).toBe(body.error);
    expect(body.output?.split("\n").length).toBeLessThanOrEqual(20);
  }, 60_000);

  it("lists a run with the PR graph-manager opened from it", async () => {
    const other = await appWithLogin();
    try {
      const ws = path.join(other.config.workspacesDir, "github", "octo", "hello");
      await mkdir(ws, { recursive: true });
      await execa("git", ["init", "-q"], { cwd: ws });
      await cp(path.join(wsDir, ".git"), path.join(ws, ".git"), { recursive: true });
      const runDir = path.join(ws, ".graph-execution", "20261106-120000-abcd");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "state.json"), "{}");
      await other.store.update((d) => {
        d.prs[`${WS}/20261106-120000-abcd`] = { url: "https://github.com/octo/hello/pull/3", number: 3, branch: "gm/x", forge: "github", createdAt: "x" };
      });
      const res = await other.app.inject({ method: "GET", url: "/api/runs", headers: { cookie: other.cookie } });
      const run = (res.json() as { runs: RunSummary[] }).runs.find((r) => r.id === "20261106-120000-abcd");
      expect(run?.pr).toEqual({ url: "https://github.com/octo/hello/pull/3", number: 3, forge: "github" });
    } finally {
      await other.cleanup();
    }
  });

  it("answers 404 for an unknown run or workspace and 400 for an invalid run id", async () => {
    expect((await api("GET", `/api/runs/${WS}/nope`)).status).toBe(404);
    expect((await api("GET", `/api/runs/github~octo~missing/nope`)).status).toBe(404);
    expect((await api("GET", `/api/runs/${WS}/.hidden`)).status).toBe(400);
    expect((await api("POST", `/api/runs/github~octo~missing`, { tasksDir: "diamond", spec: "spec.md", provider: "fake" })).status).toBe(404);
  });

  it("needs the login", async () => {
    expect((await fetch(`${base}/api/runs`)).status).toBe(401);
  });

  it.skipIf(!built)(
    "starts a fake run that shows up live, reaches applied and serves its page through the proxy",
    async () => {
      const res = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "fake" });
      const created = (await res.json()) as { runId: string; viewUrl: string; error?: string };
      expect(res.status, created.error).toBe(201);
      expect(created.runId).toMatch(/^gm-\d{8}-\d{6}-[0-9a-f]{4}$/);
      expect(created.viewUrl).toBe(`/runs/${WS}/${created.runId}/view/`);
      const web = JSON.parse(await readFile(path.join(wsDir, ".graph-execution", created.runId, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
      if (web.pid) started.push(web.pid);

      const list = async (): Promise<RunSummary | undefined> => {
        const body = (await (await api("GET", "/api/runs")).json()) as { runs: RunSummary[] };
        return body.runs.find((r) => r.id === created.runId);
      };
      const first = await poll("the run in the list", list);
      expect(first.workspaceId).toBe(WS);
      expect(first.provider).toBe("fake");

      const state = await api("GET", `${created.viewUrl}state`);
      expect(state.status).toBe(200);
      expect(((await state.json()) as { runId?: string }).runId).toBe(created.runId);

      const applied = await poll("status applied", async () => {
        const r = await list();
        return r?.status === "applied" ? r : undefined;
      });
      expect(applied.live).toBe(true);
      expect(applied.taskCounts).toEqual({ merged: 4 });

      const filtered = (await (await api("GET", `/api/runs?workspace=${WS}`)).json()) as { runs: RunSummary[] };
      expect(filtered.runs.map((r) => r.id)).toContain(created.runId);
      const detail = (await (await api("GET", `/api/runs/${WS}/${created.runId}`)).json()) as { graph: { layers: string[][] } };
      expect(detail.graph.layers).toEqual([["1"], ["2", "3"], ["4"]]);

      const close = await api("POST", `${created.viewUrl}close`);
      expect(close.status).toBeLessThan(300);
      await poll("the page to close", async () => ((await list())?.live === false ? true : undefined), 30_000);
    },
    120_000,
  );

  it.skipIf(!built)(
    "passes the stored reviewers to a started run",
    async () => {
      const added = await api("POST", "/api/reviewers", { id: "security", type: "diff", name: "Security", instructions: "Check auth", provider: "fake" });
      expect(added.status).toBe(201);
      const res = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "fake" });
      const created = (await res.json()) as { runId: string; error?: string };
      expect(res.status, created.error).toBe(201);
      const runDir = path.join(wsDir, ".graph-execution", created.runId);
      const web = JSON.parse(await readFile(path.join(runDir, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
      if (web.pid) started.push(web.pid);
      const expected = await readFile(path.join(dir, "data", "reviewers", "admin.json"), "utf8");
      expect(expected).toContain('"security"');
      const copy = await poll("the run's reviewers.json", () => readFile(path.join(runDir, "reviewers.json"), "utf8").catch(() => undefined));
      expect(copy).toBe(expected);

      // Let the run finish before the temp dir is removed.
      const list = async (): Promise<RunSummary | undefined> =>
        ((await (await api("GET", "/api/runs")).json()) as { runs: RunSummary[] }).runs.find((r) => r.id === created.runId);
      await poll("status applied", async () => ((await list())?.status === "applied" ? true : undefined));
      await api("POST", `/runs/${WS}/${created.runId}/view/close`);
      await poll("the page to close", async () => ((await list())?.live === false ? true : undefined), 30_000);
    },
    120_000,
  );
});

describe("runs API with options", () => {
  it.skipIf(!built)(
    "starts a fake run with human review that waits for the review, with the overrides in state.json",
    async () => {
      const res = await api("POST", `/api/runs/${WS}`, {
        tasksDir: "diamond",
        spec: "spec.md",
        provider: "fake",
        options: { humanReview: true, attempts: 1, fixPasses: 0 },
      });
      const created = (await res.json()) as { runId: string; viewUrl: string; error?: string };
      expect(res.status, created.error).toBe(201);
      const runDir = path.join(wsDir, ".graph-execution", created.runId);
      const web = JSON.parse(await readFile(path.join(runDir, "web.json"), "utf8").catch(() => "{}")) as { pid?: number };
      if (web.pid) started.push(web.pid);

      await poll(
        "the review to wait",
        async () => {
          const r = await api("GET", `${created.viewUrl}state`);
          if (r.status !== 200) return undefined;
          const view = (await r.json()) as { review?: { waiting?: boolean } };
          return view.review?.waiting === true ? true : undefined;
        },
        100_000,
      );
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as { humanReview?: boolean; overrides?: unknown };
      expect(state.humanReview).toBe(true);
      expect(state.overrides).toEqual({ attempts: 1, fixPasses: 0 });

      // A run waiting for the review ignores SIGTERM: drop the result and close the page so the process exits.
      const drop = await api("POST", `${created.viewUrl}review/drop`);
      expect(drop.status).toBeLessThan(300);
      const live = async (): Promise<boolean | undefined> => {
        const body = (await (await api("GET", `/api/runs?workspace=${WS}`)).json()) as { runs: RunSummary[] };
        return body.runs.find((r) => r.id === created.runId)?.live;
      };
      await poll("the run to finish", async () => {
        const r = await api("GET", `${created.viewUrl}state`);
        const view = r.status === 200 ? ((await r.json()) as { review?: { waiting?: boolean } }) : undefined;
        return view?.review?.waiting === false ? true : undefined;
      });
      // The page answers 409 until the run has finished cleaning up after the drop.
      await poll("the page to accept close", async () => ((await api("POST", `${created.viewUrl}close`)).status === 409 ? undefined : true));
      await poll("the page to close", async () => ((await live()) === false ? true : undefined), 30_000);
    },
    120_000,
  );
});

describe("helpers", () => {
  it("runs a .js bin through node and anything else directly", () => {
    expect(engineCommand("/x/cli.js", ["a"])).toEqual({ file: process.execPath, args: ["/x/cli.js", "a"] });
    expect(engineCommand("graph-execution", ["a"])).toEqual({ file: "graph-execution", args: ["a"] });
  });

  it("makes gm- run ids", () => {
    expect(newRunId(new Date(2026, 10, 6, 9, 5, 3))).toMatch(/^gm-20261106-090503-[0-9a-f]{4}$/);
  });
});
