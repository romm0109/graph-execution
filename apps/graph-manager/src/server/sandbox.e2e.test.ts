// End to end (KAN-88): a sandboxed fake-provider run through the HTTP API, with the fake Docker in exec mode (each
// container runs its Cmd as a local process on 127.0.0.<n>) and the real built engine.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import { buildApp } from "./app.js";
import { defaultGraphExecutionBin } from "./config.js";
import type { RunSummary } from "./runs.js";
import { Sandboxes } from "./sandbox.js";
import { DataStore } from "./store.js";
import { tempDir, testConfig } from "./test-helpers.js";
import { readCachedView, ViewCache } from "./viewcache.js";

const FIXTURES = fileURLToPath(new URL("../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
const WS = "github~octo~hello";

let dir: string;
let cleanup: () => Promise<void>;
let wsDir: string;
let fake: FakeDocker;
let store: DataStore;
let app: FastifyInstance;
let base: string;
let cookie: string;

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { cookie, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

const stateOf = async (file: string): Promise<{ status: string; tasks: Record<string, { status: string }> } | undefined> =>
  readFile(file, "utf8")
    .then((t) => JSON.parse(t) as { status: string; tasks: Record<string, { status: string }> })
    .catch(() => undefined);

const envOf = (env: string[], name: string): string | undefined => env.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1);

const runOf = async (runId: string): Promise<RunSummary | undefined> =>
  ((await (await api("GET", "/api/runs")).json()) as { runs: RunSummary[] }).runs.find((r) => r.id === runId);

describe.skipIf(process.platform !== "linux" || !built)("a sandboxed run, end to end", () => {
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    wsDir = path.join(dir, "ws", "github", "octo", "hello");
    await mkdir(wsDir, { recursive: true });
    const git = (...args: string[]) => execa("git", args, { cwd: wsDir });
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "t");
    await git("config", "user.email", "t@example.com");
    await cp(path.join(FIXTURES, "diamond"), path.join(wsDir, "diamond"), { recursive: true });
    await cp(path.join(FIXTURES, "spec.md"), path.join(wsDir, "spec.md"));
    await git("add", ".");
    await git("commit", "-q", "-m", "init");

    // The image step is covered by sandbox-image.test.ts.
    vi.spyOn(Sandboxes.prototype as unknown as { buildImages: () => Promise<{ image: string; clisVolume: string }> }, "buildImages").mockImplementation(async function (
      this: { opts: { config: { sandboxImage?: string } } },
    ) {
      // The built image is the recipe's base here: these tests start containers of a known image.
    // The CLI volume start() checks for (review F5); empty is enough for the fake provider.
    await (this as unknown as { docker: { createVolume(n: string): Promise<unknown> } }).docker.createVolume("gm-clis-test");
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
    });
    fake = await startFakeDocker({ exec: true });
    const config = testConfig(dir, { graphExecutionBin: BIN, dockerSocket: fake.socketPath, sandboxImage: "node:22" });
    store = await DataStore.open(config.dataDir);
    app = await buildApp(config, { store, webDir: path.join(dir, "no-web"), viewCache: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw" }) });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await fake.close();
    await cleanup();
  });

  it("runs in a container, shows its page, applies, and leaves nothing behind on Close", async () => {
    const res = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "fake", sandbox: true });
    const started = (await res.json()) as { runId: string; viewUrl: string; error?: string; output?: string };
    expect(res.status, `${started.error ?? ""}\n${started.output ?? ""}`).toBe(201);
    const { runId } = started;
    expect([...fake.containers.values()].map((c) => c.Name)).toEqual([`/gm-run-${runId}`]);

    const live = await poll("the run listed live", async () => {
      const r = await runOf(runId);
      return r?.live ? r : undefined;
    }, 30_000);
    expect(live.sandbox).toMatchObject({ running: true });

    const state = await api("GET", `/runs/${WS}/${runId}/view/state`);
    expect(state.status).toBe(200);
    expect(((await state.json()) as { runId?: string }).runId).toBe(runId);

    // The view cache reads the sandboxed page through its container address.
    const dataDir = path.join(dir, "data");
    const cache = new ViewCache({ dataDir, workspacesDir: path.join(dir, "ws") });
    await cache.tick();
    expect((await readCachedView(dataDir, WS, runId))?.runId).toBe(runId);

    const stateFile = path.join(wsDir, ".graph-execution", runId, "state.json");
    await poll("the run applied", async () => {
      const s = await readFile(stateFile, "utf8").then((t) => JSON.parse(t) as { status: string }).catch(() => undefined);
      return s?.status === "applied" ? true : undefined;
    }, 120_000);

    // A live sandbox blocks deleting its workspace.
    expect((await api("DELETE", `/api/workspaces/${WS}`)).status).toBe(409);

    const close = await api("POST", `/runs/${WS}/${runId}/view/close`, undefined, { origin: base });
    expect(close.status).toBeLessThan(300);
    await poll("the container removed", async () => (fake.containers.size === 0 && Object.keys(store.get().sandboxes).length === 0 ? true : undefined), 10_000);

    const after = await runOf(runId);
    expect(after?.live).toBe(false);
    expect(after?.sandbox).toEqual({ running: false, gone: true, image: "node:22" });
    for (const f of ["1.txt", "2.txt", "3.txt", "4.txt"]) expect(existsSync(path.join(wsDir, f)), f).toBe(true);
    const status = (await execa("git", ["status", "--porcelain"], { cwd: wsDir })).stdout;
    expect(status).toMatch(/1\.txt/);
  }, 180_000);

  describe("Resume", () => {
    let script: string;
    let saved: string | undefined;

    beforeEach(async () => {
      script = path.join(wsDir, ".git", "fake-script.json");
      await writeFile(script, JSON.stringify({ "task:4": { attempts: [{ hang: true }] } }));
      saved = process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
      process.env.GRAPH_EXECUTION_FAKE_SCRIPT = script;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
      else process.env.GRAPH_EXECUTION_FAKE_SCRIPT = saved;
    });

    /** Starts a sandboxed run and waits until task 4 hangs. */
    async function startHanging(): Promise<{ runId: string; stateFile: string }> {
      const res = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "fake", sandbox: true });
      const started = (await res.json()) as { runId: string; error?: string; output?: string };
      expect(res.status, `${started.error ?? ""}\n${started.output ?? ""}`).toBe(201);
      const { runId } = started;
      let last = "";
      await poll("task 4 running", async () => {
        const v = await api("GET", `/runs/${WS}/${runId}/view/state`).catch(() => undefined);
        if (v?.status !== 200) return undefined;
        const st = (await v.json()) as { nodes?: Record<string, { status: string }> };
        last = JSON.stringify(st.nodes);
        return st.nodes?.["4"]?.status === "running" ? true : undefined;
      }, 60_000).catch((err: unknown) => {
        throw new Error(`${String(err)}; tasks ${last}; logs ${[...fake.containers.values()].map((c) => c.logs).join("\n")}`);
      });
      return { runId, stateFile: path.join(wsDir, ".graph-execution", runId, "state.json") };
    }

    const containerGone = () =>
      poll("the container removed", async () => (fake.containers.size === 0 && Object.keys(store.get().sandboxes).length === 0 ? true : undefined), 30_000);

    async function resumeAndApply(runId: string, stateFile: string): Promise<string[]> {
      await writeFile(script, "{}");
      const res = await api("POST", `/api/runs/${WS}/${runId}/resume`);
      const body = (await res.json()) as { error?: string; output?: string };
      expect(res.status, `${body.error ?? ""}\n${body.output ?? ""}`).toBe(201);
      const cts = [...fake.containers.values()];
      expect(cts.map((c) => c.Name)).toEqual([`/gm-run-${runId}`]);
      const env = cts[0]?.Config.Env ?? [];
      await poll("the resumed run applied", async () => ((await stateOf(stateFile))?.status === "applied" ? true : undefined), 120_000);
      const close = await api("POST", `/runs/${WS}/${runId}/view/close`, undefined, { origin: base });
      expect(close.status).toBeLessThan(300);
      await containerGone();
      for (const f of ["1.txt", "2.txt", "3.txt", "4.txt"]) expect(existsSync(path.join(wsDir, f)), f).toBe(true);
      return env;
    }

    it("Abort + Close removes the container; Resume continues it in a new one and it applies", async () => {
      const { runId, stateFile } = await startHanging();
      const oldHost = Object.values(store.get().sandboxes)[0]?.host;
      const abort = await api("POST", `/runs/${WS}/${runId}/view/abort`, undefined, { origin: base });
      expect(abort.status).toBeLessThan(300);
      await poll("the run aborted", async () => ((await stateOf(stateFile))?.status === "aborted" ? true : undefined), 30_000);
      const close = await api("POST", `/runs/${WS}/${runId}/view/close`, undefined, { origin: base });
      expect(close.status).toBeLessThan(300);
      await containerGone();

      const env = await resumeAndApply(runId, stateFile);
      const take = envOf(env, "GRAPH_EXECUTION_TAKE_LOCK_FROM");
      expect(take === undefined || take === oldHost).toBe(true);
    }, 240_000);

    it("Stop sandbox kills a hanging run; Resume takes over its lock and it applies", async () => {
      const { runId, stateFile } = await startHanging();
      const oldHost = Object.values(store.get().sandboxes)[0]?.host;
      expect(oldHost).toMatch(/^sbx-/);
      const stop = await api("POST", `/api/runs/${WS}/${runId}/sandbox/stop`);
      expect(stop.status).toBe(204);
      await containerGone();
      // A SIGKILLed engine leaves its lock, with the container's hostname. The fake runs the engine on this host (and
      // it may release the lock on SIGTERM), so write that lock as a killed engine in a real container leaves it.
      const lockFile = path.join(wsDir, ".graph-execution", runId, "lock");
      const left = await readFile(lockFile, "utf8").catch(() => "999999\nt\n");
      const [pid = "999999", token = "t"] = left.split("\n");
      await writeFile(lockFile, `${pid}\n${token}\n${oldHost ?? ""}\nsandbox\n`);

      const env = await resumeAndApply(runId, stateFile);
      expect(envOf(env, "GRAPH_EXECUTION_TAKE_LOCK_FROM")).toBe(oldHost);
    }, 240_000);
  });
});
