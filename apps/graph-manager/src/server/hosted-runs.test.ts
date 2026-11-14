// Hosted runs (docs/prd/hosted-sessions.md, "Hosted runs"): a remote session's run in its own run container. The
// provisioner hands out in-process workspace agents (no Docker); the end-to-end cases run the real built engine with
// the fake provider and open their PRs on the fake forge.
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeForge, type FakeForge } from "../../scripts/fake-forge.mjs";
import { startAgent } from "./agent/server.js";
import type { AppContext } from "./app.js";
import { defaultGraphExecutionBin, type Config } from "./config.js";
import { endedStatus } from "./hosted-runs.js";
import { RemoteWorkspaceHost } from "./host/remote.js";
import type { WorkspaceHost } from "./host/types.js";
import { ADMIN_USER } from "./identity.js";
import type { RunSummary } from "./runs.js";
import type { SessionProvisioner } from "./sessions/provisioner.js";
import type { HostedRunRecord, SqlStore } from "./store.js";
import { appWithLogin } from "./test-helpers.js";

const FIXTURES = fileURLToPath(new URL("../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
const WS = "github~octo~hello";
const TOKEN = "agent-token";

/** Session and run containers as in-process workspace agents on their own folders under `root`. */
class AgentProvisioner implements SessionProvisioner {
  readonly agents = new Map<string, { host: RemoteWorkspaceHost; close(): Promise<void>; dir: string }>();
  readonly acquiredRuns: string[] = [];
  readonly releasedRuns: string[] = [];

  constructor(private readonly root: string) {}

  private async agent(key: string): Promise<RemoteWorkspaceHost> {
    const have = this.agents.get(key);
    if (have) return have.host;
    const dir = path.join(this.root, key);
    await mkdir(dir, { recursive: true });
    const a = await startAgent({ port: 0, workspacesDir: dir, token: TOKEN, graphExecutionBin: BIN });
    const host = new RemoteWorkspaceHost(a.url, TOKEN);
    this.agents.set(key, { host, close: a.close, dir });
    return host;
  }

  dirOf(key: string): string {
    return path.join(this.root, key);
  }

  acquire(p: { sessionId: string }): Promise<WorkspaceHost> {
    return this.agent(`session-${p.sessionId}`);
  }

  async release(p: { sessionId: string }): Promise<void> {
    await this.drop(`session-${p.sessionId}`);
  }

  async acquireRun(p: { runId: string }): Promise<WorkspaceHost> {
    this.acquiredRuns.push(p.runId);
    return this.agent(`run-${p.runId}`);
  }

  async releaseRun(p: { runId: string }): Promise<void> {
    this.releasedRuns.push(p.runId);
    await this.drop(`run-${p.runId}`);
  }

  private async drop(key: string): Promise<void> {
    const a = this.agents.get(key);
    this.agents.delete(key);
    await a?.close();
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.agents.keys()]) await this.drop(key);
  }
}

let forgeDir: string;
let forge: FakeForge;
let root: string;
let prov: AgentProvisioner;
let app: FastifyInstance;
let ctx: AppContext;
let stores: SqlStore;
let cookie: string;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  forgeDir = await mkdtemp(path.join(os.tmpdir(), "gm-hosted-forge-"));
  forge = await startFakeForge({ dir: forgeDir });
  forge.addRepo("octo/hello", "github");
  forge.addRepo("octo/web", "github");
});

afterAll(async () => {
  await forge.close();
  await rm(forgeDir, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gm-hosted-"));
  prov = new AgentProvisioner(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = undefined;
  await prov.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function start(overrides: Partial<Config> = {}): Promise<void> {
  const res = await appWithLogin(
    { githubApiUrl: `${forge.url}/github`, graphExecutionBin: BIN, ...overrides },
    { provisioner: prov, hostedRunsIntervalMs: 100, sessions: { pollMs: 20 }, onContext: (c) => (ctx = c) },
  );
  ({ app, cookie, stores } = res);
  cleanup = res.cleanup;
  const put = await req("PUT", "/api/forges/github", { token: "gh-good" });
  expect(put.statusCode, put.body).toBe(200);
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
const req = (method: Method, url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd })).stdout.trim();
const record = async (runId: string): Promise<HostedRunRecord | undefined> => (await stores.forUser(ADMIN_USER)).get().hostedRuns[runId];

async function poll<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let branchNo = 0;

/** Opens a session on octo/hello with a new branch; with `seed`, commits and pushes the diamond fixture and a spec. */
async function openSession(seed = true): Promise<{ sessionId: string; branch: string; dir: string; host: WorkspaceHost }> {
  const branch = `feat-hosted-${Date.now()}-${++branchNo}`;
  const res = await req("POST", "/api/sessions", { repo: { forge: "github", owner: "octo", name: "hello" }, branch: { new: branch } });
  expect(res.statusCode, res.body).toBe(201);
  const { sessionId } = res.json<{ sessionId: string }>();
  const dir = path.join(prov.dirOf(`session-${sessionId}`), "github", "octo", "hello");
  const host = await ctx.hostFor(WS, ADMIN_USER);
  expect(host.kind).toBe("remote");
  if (seed) {
    await cp(path.join(FIXTURES, "diamond"), path.join(dir, "diamond"), { recursive: true });
    await mkdir(path.join(dir, "docs", "prd"), { recursive: true });
    await cp(path.join(FIXTURES, "spec.md"), path.join(dir, "docs", "prd", "hello.md"));
    await host.git(WS, ["add", "-A"]);
    await host.git(WS, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "tasks"]);
    // Not pushed here: the run start pushes the session branch itself.
  }
  return { sessionId, branch, dir, host };
}

const START = { tasksDir: "diamond", spec: "docs/prd/hello.md", provider: "fake" };

describe("endedStatus", () => {
  it("ends on applied, done, failed, aborted, and on interrupted once nothing drives the run", () => {
    const d = (status: string, live = false) => ({ summary: { workspaceId: WS, type: "run" as const, id: "r", status, kind: "x", live } });
    for (const s of ["applied", "done", "failed", "aborted"]) expect(endedStatus(d(s))).toBe(s);
    expect(endedStatus(d("running"))).toBeUndefined();
    expect(endedStatus(d("interrupted", true))).toBeUndefined();
    expect(endedStatus(d("interrupted"))).toBe("interrupted");
    expect(endedStatus(undefined)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("the workspace agent's hosted-run routes", () => {
  it("writes files only inside the workspace and answers their paths; lists a run folder without worktrees", async () => {
    const dir = path.join(root, "agent");
    const ws = path.join(dir, "github", "octo", "hello");
    await mkdir(ws, { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: ws });
    const a = await startAgent({ port: 0, workspacesDir: dir, token: TOKEN });
    try {
      const host = new RemoteWorkspaceHost(a.url, TOKEN);
      expect(await host.writeFiles(WS, { "specs/a.md": "# A\n" })).toEqual({ "specs/a.md": path.join(ws, "specs", "a.md") });
      expect(await readFile(path.join(ws, "specs", "a.md"), "utf8")).toBe("# A\n");
      for (const bad of ["../x", "/etc/x", ".git/config", "a//b"]) await expect(host.writeFiles(WS, { [bad]: "x" })).rejects.toThrow(/invalid path/);
      const runId = "gm-20261114-000000-cccc";
      const run = path.join(ws, ".graph-execution", runId);
      await mkdir(path.join(run, "worktrees", "1"), { recursive: true });
      await mkdir(path.join(run, "tasks"), { recursive: true });
      await writeFile(path.join(run, "state.json"), "{}");
      await writeFile(path.join(run, "tasks", "1.log"), "log");
      await writeFile(path.join(run, "worktrees", "1", "big.txt"), "skip me");
      const folder = await host.runFolder(WS, runId);
      expect(folder?.files.map((f) => [f.path, f.content.toString()])).toEqual([
        ["state.json", "{}"],
        ["tasks/1.log", "log"],
      ]);
      expect(await host.runFolder(WS, "gm-20261114-000000-dddd")).toBeUndefined();
    } finally {
      await a.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("hosted runs: the start (no engine)", () => {
  it("answers 409 with the exact message when the user has as many active hosted runs as GM_MAX_RUN_CONTAINERS", async () => {
    await start({ maxRunContainers: 1 });
    const { sessionId, branch } = await openSession(false);
    const us = await stores.forUser(ADMIN_USER);
    await us.update((d) => {
      d.hostedRuns["gm-20261114-000000-aaaa"] = { runId: "gm-20261114-000000-aaaa", sessionId, workspaceId: WS, branch, state: "running", startedAt: new Date().toISOString() };
    });
    const res = await req("POST", `/api/runs/${WS}`, START);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "You have 1 sandboxed runs. Wait for one to finish or stop it." });
    // The active run was taken up again (its container is still there after a restart); no new one was acquired.
    expect(prov.acquiredRuns).toEqual(["gm-20261114-000000-aaaa"]);
  });

  it("answers 409 when the session branch cannot be pushed, before any run container", async () => {
    await start();
    const { branch, host } = await openSession();
    vi.spyOn(host, "pushBranch").mockResolvedValue({ ok: false, error: "rejected" });
    const res = await req("POST", `/api/runs/${WS}`, START);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: `Could not push ${branch} before the run: rejected` });
    expect(prov.acquiredRuns).toEqual([]);
    expect((await stores.forUser(ADMIN_USER)).get().hostedRuns).toEqual({});
  });

  it("checks the paths on the session host, ignores `sandbox`, and never starts a local sandbox", async () => {
    await start();
    await openSession();
    const sandboxStart = vi.spyOn(ctx.sandboxes!, "start");
    const res = await req("POST", `/api/runs/${WS}`, { ...START, tasksDir: "nope", sandbox: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "tasksDir: nope is not a folder inside the workspace" });
    expect(sandboxStart).not.toHaveBeenCalled();
    expect(prov.acquiredRuns).toEqual([]);
  });

  it("releases the run container and drops the record when the engine does not start", async () => {
    await start();
    await openSession();
    vi.spyOn(RemoteWorkspaceHost.prototype, "startEngine").mockResolvedValue({ ok: false, error: "graph-execution exited with code 2", exitCode: 2, output: "boom" });
    const res = await req("POST", `/api/runs/${WS}`, START);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "graph-execution exited with code 2", exitCode: 2, output: "boom" });
    expect(prov.acquiredRuns).toHaveLength(1);
    expect(prov.releasedRuns).toEqual(prov.acquiredRuns);
    expect((await stores.forUser(ADMIN_USER)).get().hostedRuns).toEqual({});
  });

  it("inspect says hosted, with the session's repository", async () => {
    await start();
    const { dir } = await openSession(false);
    await writeFile(path.join(dir, "scratch.txt"), "draft\n");
    const res = await req("GET", `/api/workspaces/${WS}/inspect`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ hosted: true, repo: "octo/hello", changes: 1 });
  });

  it("ends a closed session only after its hosted run is no longer active", async () => {
    await start();
    const { sessionId, branch } = await openSession(false);
    const us = await stores.forUser(ADMIN_USER);
    const runId = "gm-20261114-000000-bbbb";
    await us.update((d) => {
      d.hostedRuns[runId] = { runId, sessionId, workspaceId: WS, branch, state: "running", startedAt: new Date().toISOString() };
    });
    const ending = ctx.sessions.end(ADMIN_USER, sessionId);
    await new Promise((r) => setTimeout(r, 200));
    expect((await ctx.sessions.get(ADMIN_USER, sessionId))?.state).toBe("ending");
    await us.update((d) => {
      d.hostedRuns[runId]!.state = "done";
    });
    await ending;
    expect(await ctx.sessions.get(ADMIN_USER, sessionId)).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "linux" || !built)("hosted runs, end to end", () => {
  it("runs in its own container from the pushed session branch, opens the PR into it, archives and releases", async () => {
    await start({ maxRunContainers: 1 });
    const { branch, dir } = await openSession();
    await writeFile(path.join(dir, "scratch.txt"), "not committed\n");
    const sessionHead = await git(dir, "rev-parse", "HEAD");

    const res = await req("POST", `/api/runs/${WS}`, START);
    expect(res.statusCode, res.body).toBe(201);
    const { runId, viewUrl } = res.json<{ runId: string; viewUrl: string }>();
    expect(viewUrl).toBe(`/runs/${WS}/${runId}/view/`);
    expect(prov.acquiredRuns).toEqual([runId]);
    // The session branch was pushed first, and the run container cloned it at that commit.
    expect(await git(path.join(forge.dir, "octo/hello.git"), "rev-parse", `refs/heads/${branch}`)).toBe(sessionHead);
    const runDir = path.join(prov.dirOf(`run-${runId}`), "github", "octo", "hello");
    expect(await git(runDir, "branch", "--show-current")).toBe(branch);
    expect(await git(runDir, "rev-parse", "HEAD")).toBe(sessionHead);
    expect(existsSync(path.join(runDir, "scratch.txt"))).toBe(false);
    // The run owner's reviewers file, as a local run gets it.
    const reviewers = JSON.parse(await readFile(path.join(runDir, ".graph-execution", "gm-reviewers.json"), "utf8")) as { reviewers: unknown[] };
    expect(Array.isArray(reviewers.reviewers)).toBe(true);

    // One active run with GM_MAX_RUN_CONTAINERS=1: a second start is refused.
    const second = await req("POST", `/api/runs/${WS}`, START);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "You have 1 sandboxed runs. Wait for one to finish or stop it." });

    // While live, the run page is proxied from the run container (through a listening server: the proxy hijacks).
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let sawPage = false;
    await poll("the run to end", async () => {
      if (!sawPage) {
        const v = await fetch(`${base}/runs/${WS}/${runId}/view/state`, { headers: { cookie } }).catch(() => undefined);
        if (v?.status === 200) {
          const body = await v.text();
          if (body.includes(runId)) sawPage = true;
        }
      }
      const r = await record(runId);
      return r && (r.state === "done" || r.state === "failed") ? r : undefined;
    });
    expect(sawPage).toBe(true);
    const rec = (await record(runId))!;
    expect(rec, JSON.stringify(rec)).toMatchObject({ state: "done", branch });
    expect(rec.prError).toBeUndefined();

    const pulls = forge.pulls.filter((p) => p.head === `gm/${runId}`);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ fullPath: "octo/hello", base: branch });
    expect(rec.prUrl).toBe(`${forge.url}/web/github/octo/hello/pull/${pulls[0]!.number}`);
    const bare = path.join(forge.dir, "octo/hello.git");
    const tree = await git(bare, "ls-tree", "-r", "--name-only", `gm/${runId}`);
    expect(tree.split("\n")).toContain("docs/prd/done/hello.md");
    expect(tree.split("\n")).not.toContain("docs/prd/hello.md");
    expect(prov.releasedRuns).toEqual([runId]);

    // The session's own files did not change.
    expect(await readFile(path.join(dir, "scratch.txt"), "utf8")).toBe("not committed\n");
    expect(await git(dir, "rev-parse", "HEAD")).toBe(sessionHead);
    expect(await git(dir, "status", "--porcelain")).toBe("?? scratch.txt");

    // Listed and opened from the archive, with the PR link.
    const list = (await req("GET", "/api/runs")).json<{ runs: RunSummary[] }>().runs;
    expect(list.find((r) => r.id === runId)).toMatchObject({ workspaceId: WS, archived: true });
    const detail = await req("GET", `/api/runs/${WS}/${runId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ summary: RunSummary }>().summary.pr?.url).toBe(rec.prUrl);
    const pr = (await req("GET", `/api/runs/${WS}/${runId}/pr`)).json<{ pr?: { url: string } }>();
    expect(pr.pr?.url).toBe(rec.prUrl);
  }, 180_000);

  describe("with a failing task", () => {
    let saved: string | undefined;
    let script: string;
    beforeEach(async () => {
      script = path.join(root, "fake-script.json");
      await writeFile(script, JSON.stringify({ "task:4": { attempts: Array.from({ length: 10 }, () => ({ exitCode: 1, commit: false })) } }));
      saved = process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
      process.env.GRAPH_EXECUTION_FAKE_SCRIPT = script;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
      else process.env.GRAPH_EXECUTION_FAKE_SCRIPT = saved;
    });

    it("waits for a retry while the task has failed; closed from its page, it ends failed: archived, released, no PR", async () => {
      await start();
      await openSession();
      const res = await req("POST", `/api/runs/${WS}`, START);
      expect(res.statusCode, res.body).toBe(201);
      const { runId } = res.json<{ runId: string }>();
      // With --web the engine keeps the run open for a retry in its page: still active.
      await poll("task 4 to fail", async () => {
        const d = await req("GET", `/api/runs/${WS}/${runId}`);
        const tasks = d.statusCode === 200 ? d.json<{ state?: { tasks?: Record<string, { status: string }> } }>().state?.tasks : undefined;
        return tasks?.["4"]?.status === "failed" ? true : undefined;
      });
      expect((await record(runId))?.state).toBe("running");
      expect(prov.releasedRuns).toEqual([]);
      // Close from the run page (as the user would), through the proxy to the run container.
      await app.listen({ port: 0, host: "127.0.0.1" });
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const close = await fetch(`${base}/runs/${WS}/${runId}/view/close`, { method: "POST", headers: { cookie } });
      expect(close.status, await close.text()).toBe(200);
      const rec = await poll("the run to end", async () => {
        const r = await record(runId);
        return r && (r.state === "done" || r.state === "failed") ? r : undefined;
      });
      expect(rec.state, JSON.stringify(rec)).toBe("failed");
      expect(rec.prUrl).toBeUndefined();
      expect(forge.pulls.filter((p) => p.head === `gm/${runId}`)).toEqual([]);
      expect(prov.releasedRuns).toEqual([runId]);
      const detail = await req("GET", `/api/runs/${WS}/${runId}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ archived: true });
    }, 180_000);
  });

  it("keeps the pushed gm/<runId> when opening the PR fails, releases anyway, and Create PR retries it", async () => {
    await start();
    const { branch } = await openSession();
    const res = await req("POST", `/api/runs/${WS}`, START);
    expect(res.statusCode, res.body).toBe(201);
    const { runId } = res.json<{ runId: string }>();
    // The forge goes away (the bare repos stay: pushes still work over file://).
    const port = Number(new URL(forge.url).port);
    await forge.close();
    try {
      const rec = await poll("the run to end", async () => {
        const r = await record(runId);
        return r && (r.state === "done" || r.state === "failed") ? r : undefined;
      });
      expect(rec.prError, JSON.stringify(rec)).toMatch(/create failed/);
      expect(rec.prUrl).toBeUndefined();
      expect(prov.releasedRuns).toEqual([runId]);
      expect(await git(path.join(forgeDir, "octo/hello.git"), "rev-parse", "--verify", `refs/heads/gm/${runId}`)).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      forge = await startFakeForge({ port, dir: forgeDir });
      forge.addRepo("octo/hello", "github");
      forge.addRepo("octo/web", "github");
    }
    const status = (await req("GET", `/api/runs/${WS}/${runId}/pr`)).json<{ eligible: boolean; reason?: string; suggested?: { branch: string; base: string } }>();
    expect(status).toMatchObject({ eligible: true, suggested: { branch: `gm/${runId}`, base: branch } });
    expect(status.reason).toMatch(/create failed/);
    const retry = await req("POST", `/api/runs/${WS}/${runId}/pr`, { branch: `gm/${runId}`, title: "x" });
    expect(retry.statusCode, retry.body).toBe(202);
    expect(retry.json()).toMatchObject({ job: { status: "done", pr: { branch: `gm/${runId}` } } });
    expect(forge.pulls.filter((p) => p.head === `gm/${runId}`)).toHaveLength(1);
    expect((await record(runId))?.prUrl).toBeDefined();
    expect((await record(runId))?.prError).toBeUndefined();
    const again = await req("POST", `/api/runs/${WS}/${runId}/pr`, { branch: `gm/${runId}`, title: "x" });
    expect(again.statusCode).toBe(409);
  }, 180_000);

  it("runs a project session's suite in one run container and opens one linked PR per changed repository", async () => {
    await start();
    const made = await req("POST", "/api/projects", { name: "billing", repos: [{ forge: "github", owner: "octo", name: "hello" }, { forge: "github", owner: "octo", name: "web" }] });
    expect(made.statusCode, made.body).toBe(201);
    const branch = `feat-project-${Date.now()}`;
    const opened = await req("POST", "/api/sessions", { projectId: "billing", branch: { new: branch } });
    expect(opened.statusCode, opened.body).toBe(201);
    const { sessionId } = opened.json<{ sessionId: string }>();
    const HOME = "project~billing";
    // The project's inputs, written in the session's project folder (they exist only there).
    const proj = path.join(prov.dirOf(`session-${sessionId}`), ".projects", "billing");
    await writeFile(path.join(proj, "contract.md"), "# Contract\n\nNothing shared.\n");
    await mkdir(path.join(proj, "specs"), { recursive: true });
    for (const name of ["hello", "web"]) {
      await writeFile(path.join(proj, "specs", `${name}.md`), `# Change ${name}\n\nAdd a file.\n`);
      await mkdir(path.join(proj, "tasks", name), { recursive: true });
      await writeFile(path.join(proj, "tasks", name, "1.json"), JSON.stringify({ id: "1", content: `# Add a file to ${name}\n\nDo it.`, dependencies: [] }));
    }
    const res = await req("POST", `/api/runs/${HOME}`, { provider: "fake" });
    expect(res.statusCode, res.body).toBe(201);
    const { runId } = res.json<{ runId: string }>();
    expect(runId).toMatch(/^suite-gm-/);
    expect(prov.acquiredRuns).toEqual([runId]);
    const rec = await poll("the suite to end", async () => {
      const r = await record(runId);
      return r && (r.state === "done" || r.state === "failed") ? r : undefined;
    });
    expect(rec, JSON.stringify(rec)).toMatchObject({ state: "done", branch });
    expect(rec.prError).toBeUndefined();
    const pulls = forge.pulls.filter((p) => p.head === `gm/${runId}`);
    expect(pulls.map((p) => p.fullPath).sort()).toEqual(["octo/hello", "octo/web"]);
    for (const p of pulls) {
      expect(p.base).toBe(branch);
      expect(p.body).toContain("## Related PRs");
      const tree = await git(path.join(forge.dir, `${p.fullPath}.git`), "ls-tree", "-r", "--name-only", `gm/${runId}`);
      expect(tree.split("\n")).toContain("docs/prd/done/billing.md");
    }
    expect(prov.releasedRuns).toEqual([runId]);
    const status = (await req("GET", `/api/runs/${HOME}/${runId}/pr`)).json<{ project: true; repos: { name: string; pr?: { url: string }; linked?: boolean }[] }>();
    expect(status.repos.every((r) => r.pr && r.linked)).toBe(true);
    const detail = await req("GET", `/api/runs/${HOME}/${runId}`);
    expect(detail.statusCode, detail.body).toBe(200);
  }, 180_000);
});
