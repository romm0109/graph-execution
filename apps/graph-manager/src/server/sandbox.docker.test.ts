// End to end with a REAL Docker daemon (KAN-88): a sandboxed fake-provider run in a real container. Skipped when no
// daemon is reachable on /var/run/docker.sock or the image is not present locally: the test never pulls images.
//   docker pull node:22-bookworm && npm test -w graph-manager -- sandbox.docker
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { defaultGraphExecutionBin } from "./config.js";
import { DockerClient } from "./docker.js";
import { Sandboxes } from "./sandbox.js";
import { CLIS_TARGET, cliImageTag, ensureCliImage, ensureClisVolume } from "./sandbox-image.js";
import { DataStore } from "./store.js";
import { tempDir, testConfig } from "./test-helpers.js";

const FIXTURES = fileURLToPath(new URL("../../../../packages/graph-execution/src/__fixtures__/", import.meta.url));
const BIN = defaultGraphExecutionBin();
const built = existsSync(BIN);
const SOCKET = "/var/run/docker.sock";
const IMAGE = process.env.GM_TEST_SANDBOX_IMAGE ?? "node:22-bookworm";
const WS = "github~octo~hello";

const docker = new DockerClient(SOCKET);
const linux = process.platform === "linux";
const reachable = linux && (await docker.ping().then(() => true, () => false));
const hasImage = reachable && (await docker.imageExists(IMAGE).catch(() => false));
const missing = !linux
  ? "not on Linux"
  : !built
    ? `${BIN} is missing; run \`npm run build -w graph-execution\` first`
    : !reachable
      ? `no Docker daemon on ${SOCKET}`
      : !hasImage
        ? `the image ${IMAGE} is not present locally (docker pull ${IMAGE})`
        : undefined;
if (missing) console.warn(`skipping the real-Docker sandbox test: ${missing}`);

let dir: string;
let cleanup: () => Promise<void>;
let wsDir: string;
let store: DataStore;
let app: FastifyInstance;
let base: string;
let cookie: string;
let savedScript: string | undefined;

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

const stateOf = async (file: string): Promise<{ status: string } | undefined> =>
  readFile(file, "utf8")
    .then((t) => JSON.parse(t) as { status: string })
    .catch(() => undefined);

const ourContainers = async () => (await docker.listContainers("gm.run")).filter((c) => c.Labels["gm.workspace"] === WS);

async function removeOurs(): Promise<void> {
  if (!reachable) return;
  for (const c of await ourContainers().catch(() => [])) await docker.removeContainer(c.Id, { force: true }).catch(() => undefined);
}

describe.skipIf(missing !== undefined)("a sandboxed run in a real Docker container", () => {
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

    // Task 4 hangs, which keeps the container running deterministically while the checks run.
    const script = path.join(wsDir, ".git", "fake-script.json");
    await writeFile(script, JSON.stringify({ "task:4": { attempts: [{ hang: true }] } }));
    savedScript = process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
    process.env.GRAPH_EXECUTION_FAKE_SCRIPT = script;

    // The image step is covered by sandbox-image.test.ts: Docker creates the named volume empty on mount, enough for the fake provider.
    vi.spyOn(Sandboxes.prototype as unknown as { buildImages: () => Promise<{ image: string; clisVolume: string }> }, "buildImages").mockImplementation(async function (
      this: { opts: { config: { sandboxImage?: string } } },
    ) {
      // The built image is the recipe's base here: these tests start containers of a known image.
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
    });
    const config = testConfig(dir, { graphExecutionBin: BIN, dockerSocket: SOCKET, sandboxImage: IMAGE });
    store = await DataStore.open(config.dataDir);
    app = await buildApp(config, { store, webDir: path.join(dir, "no-web"), viewCache: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedScript === undefined) delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
    else process.env.GRAPH_EXECUTION_FAKE_SCRIPT = savedScript;
    await removeOurs();
    await app.close();
    await cleanup();
  });

  afterAll(removeOurs);

  it("isolates the run, limits it, serves its page, aborts and leaves no container on Close", async () => {
    const res = await api("POST", `/api/runs/${WS}`, { tasksDir: "diamond", spec: "spec.md", provider: "fake", sandbox: true });
    const started = (await res.json()) as { runId: string; error?: string; output?: string };
    expect(res.status, `${started.error ?? ""}\n${started.output ?? ""}`).toBe(201);
    const { runId } = started;
    const name = `gm-run-${runId}`;

    const info = await docker.inspectContainer(name);
    expect(info?.State.Running).toBe(true);
    expect(info?.HostConfig?.Memory).toBe(4096 * 1048576);
    const owner = await stat(wsDir);
    expect((info?.Config as { User?: string } | undefined)?.User).toBe(`${owner.uid}:${owner.gid}`);
    expect((info?.Config.Env ?? []).filter((e) => e.startsWith("GM_"))).toEqual([]);

    let last = "";
    await poll("task 4 running", async () => {
      const v = await api("GET", `/runs/${WS}/${runId}/view/state`).catch(() => undefined);
      if (v?.status !== 200) return undefined;
      const st = (await v.json()) as { nodes?: Record<string, { status: string }> };
      last = JSON.stringify(st.nodes);
      return st.nodes?.["4"]?.status === "running" ? true : undefined;
    }, 90_000).catch(async (err: unknown) => {
      throw new Error(`${String(err)}; tasks ${last}; logs ${await docker.containerLogs(name, 50).catch(() => "")}`);
    });

    // Inside: only this workspace, no data dir, no GM_* variables.
    const dataDir = path.join(dir, "data");
    const probe = await execa(
      "docker",
      ["exec", name, "sh", "-c", `ls ${path.dirname(wsDir)}; cat ${path.join(dataDir, "graph-manager.json")}; echo rc=$?; env | grep -c ^GM_ || true`],
      { reject: false },
    );
    const lines = probe.stdout.split("\n").filter((l) => l !== "");
    expect(lines[0]).toBe("hello");
    expect(lines).toContain("rc=1");
    expect(lines.at(-1)).toBe("0");
    expect(probe.stdout).not.toMatch(/sessionSecret|token/i);

    const state = await api("GET", `/runs/${WS}/${runId}/view/state`);
    expect(state.status).toBe(200);

    const stateFile = path.join(wsDir, ".graph-execution", runId, "state.json");
    const abort = await api("POST", `/runs/${WS}/${runId}/view/abort`, undefined, { origin: base });
    expect(abort.status).toBeLessThan(300);
    await poll("the run aborted", async () => ((await stateOf(stateFile))?.status === "aborted" ? true : undefined), 30_000);

    const close = await api("POST", `/runs/${WS}/${runId}/view/close`, undefined, { origin: base });
    expect(close.status).toBeLessThan(300);
    await poll(
      "the container removed",
      async () => ((await docker.listContainers("gm.run")).some((c) => c.Labels["gm.run"] === runId) ? undefined : true),
      20_000,
    );
    expect(Object.keys(store.get().sandboxes)).toEqual([]);
  }, 180_000);
});

// The provider CLIs image for real (docs/prd/sandbox-image.md): built by Docker, so the CLIs are Linux builds for the
// daemon's CPU whatever OS graph-manager runs on (macOS included). Needs the network for npm; skipped when the daemon
// is not reachable or node:24.22.1-bookworm-slim is not present locally.
//   docker pull node:24.22.1-bookworm-slim && npm test -w graph-manager -- sandbox.docker
const CLI_BASE = "node:24.22.1-bookworm-slim";
const daemon = await docker.ping().then(() => true, () => false);
const hasCliBase = daemon && (await docker.imageExists(CLI_BASE).catch(() => false));
const cliMissing = !daemon ? `no Docker daemon on ${SOCKET}` : !hasCliBase ? `the image ${CLI_BASE} is not present locally (docker pull ${CLI_BASE})` : undefined;
if (cliMissing) console.warn(`skipping the real-Docker CLI image test: ${cliMissing}`);

describe.skipIf(cliMissing !== undefined)("the provider CLIs image in a real Docker daemon", () => {
  const version = `test-${process.pid}`;
  let volume: string | undefined;

  afterAll(async () => {
    if (volume) await docker.removeVolume(volume).catch(() => undefined);
    await docker.removeImage(cliImageTag(version)).catch(() => undefined);
  });

  it("builds the CLIs, fills the gm-clis volume, and claude --version runs from it in another image", async () => {
    const log: string[] = [];
    const image = await ensureCliImage(docker, version, { onLine: (l) => log.push(l) });
    volume = await ensureClisVolume(docker, image);
    // A second fill of the filled volume leaves it as it is.
    expect(await ensureClisVolume(docker, image)).toBe(volume);

    // Another image than the CLIs one, as a sandbox would be, with the volume read-only as clisMount() gives it.
    const id = await docker.createContainer(`gm-clis-check-${process.pid}`, {
      Image: CLI_BASE,
      Cmd: ["sh", "-c", `${CLIS_TARGET}/bin/claude --version && ${CLIS_TARGET}/bin/codex --version`],
      HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: CLIS_TARGET, ReadOnly: true }] },
    });
    try {
      await docker.startContainer(id);
      const code = await docker.waitContainer(id);
      const out = await docker.containerLogs(id, 50).catch(() => "");
      expect(code, `${out}\n${log.slice(-20).join("\n")}`).toBe(0);
      expect(out).not.toMatch(/Exec format error|not found/);
    } finally {
      await docker.removeContainer(id, { force: true }).catch(() => undefined);
    }
  }, 900_000);
});
