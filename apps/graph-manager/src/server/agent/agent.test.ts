import { randomBytes } from "node:crypto";
import { stat as fsStat, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostContractSuite } from "../host/contract.js";
import { RemoteWorkspaceHost } from "../host/remote.js";
import { HostError } from "../host/types.js";
import { LOGIN_FILES } from "../sandbox-run.js";
import { tempDir } from "../test-helpers.js";
import { startAgent } from "./server.js";

hostContractSuite("RemoteWorkspaceHost", async (env) => {
  const token = randomBytes(32).toString("hex");
  const a = await startAgent({ port: 0, workspacesDir: env.workspacesDir, token, graphExecutionBin: env.graphExecutionBin, loginHome: env.loginHome });
  return { host: new RemoteWorkspaceHost(a.url, token), close: a.close };
});

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const repo = { forge: "github", owner: "acme", name: "api" } as const;
const ID = "github~acme~api";
const RUN_ID = "gm-20260101-000000-abcd";

describe("the workspace agent", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let token: string;
  let agent: { url: string; close(): Promise<void> };
  let host: RemoteWorkspaceHost;
  let loginHome: string;
  let cloneUrl: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir("gm-agent-"));
    const bare = path.join(dir, "api.git");
    await execa("git", ["init", "--bare", "-q", "-b", "main", bare]);
    const seed = path.join(dir, "seed");
    await execa("git", ["clone", "-q", bare, seed], { env: gitEnv });
    await execa("git", ["checkout", "-q", "-b", "main"], { cwd: seed, env: gitEnv });
    await writeFile(path.join(seed, "README.md"), "seed\n");
    await execa("git", ["add", "-A"], { cwd: seed, env: gitEnv });
    await execa("git", ["commit", "-q", "-m", "seed"], { cwd: seed, env: gitEnv });
    await execa("git", ["push", "-q", "origin", "main"], { cwd: seed, env: gitEnv });
    cloneUrl = pathToFileURL(bare).href;
    loginHome = path.join(dir, "home");
    await mkdir(path.join(dir, "ws"), { recursive: true });
    await mkdir(loginHome, { recursive: true });
    token = randomBytes(32).toString("hex");
    agent = await startAgent({ port: 0, workspacesDir: path.join(dir, "ws"), token, graphExecutionBin: "graph-execution", loginHome });
    host = new RemoteWorkspaceHost(agent.url, token);
  });

  afterEach(async () => {
    await agent.close();
    await cleanup();
  });

  it("answers 401 without the bearer token, except healthz", async () => {
    const none = await fetch(`${agent.url}/agent/v1/activity`);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });
    const wrong = await fetch(`${agent.url}/agent/v1/activity`, { headers: { authorization: "Bearer wrong" } });
    expect(wrong.status).toBe(401);
    const unknown = await fetch(`${agent.url}/agent/v1/nope`);
    expect(unknown.status).toBe(401);
    const unknownAuthed = await fetch(`${agent.url}/agent/v1/nope`, { headers: { authorization: `Bearer ${token}` } });
    expect(unknownAuthed.status).toBe(404);
    const ok = await fetch(`${agent.url}/agent/v1/activity`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    const health = await fetch(`${agent.url}/agent/v1/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it("answers 400 for a bad body", async () => {
    const res = await fetch(`${agent.url}/agent/v1/changes`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: ID, extra: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a PTY WebSocket without the token", async () => {
    const ws = new WebSocket(`${agent.url.replace(/^http/, "ws")}/agent/v1/pty/x`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("error", () => resolve(false));
      ws.addEventListener("close", () => resolve(false));
    });
    expect(opened).toBe(false);
  });

  it("rejects with HostError 502 when the agent does not answer", async () => {
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const dead = new RemoteWorkspaceHost(`http://127.0.0.1:${port}`, token);
    const err = await dead.activity().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).status).toBe(502);
    expect((err as HostError).message).toContain("did not answer");
  });

  it("round-trips the claude login files into its loginHome with mode 600", async () => {
    const files = Object.fromEntries(LOGIN_FILES.claude!.map((f) => [f, Buffer.from(`content of ${f}`).toString("base64")]));
    expect(Object.keys(files)).toEqual([".claude/.credentials.json", ".claude.json"]);
    expect(await host.loginFiles("put", ["claude"], files)).toEqual({});
    expect(await host.loginFiles("get", ["claude"])).toEqual(files);
    for (const f of Object.keys(files)) {
      expect(await readFile(path.join(loginHome, f), "utf8")).toBe(`content of ${f}`);
      if (process.platform !== "win32") expect((await fsStat(path.join(loginHome, f))).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps a HostError's status and message over the wire", async () => {
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
    const top = (await host.git(ID, ["rev-parse", "--show-toplevel"])).stdout.trim();
    await writeFile(path.join(top, "dirty.txt"), "x");
    const err = await host.prepare({ repo, branch: { existing: "main" }, cloneUrl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).status).toBe(409);
    expect((err as HostError).message).toBe("acme/api has uncommitted changes. Close its session with Push or Discard first.");
    const unknown = await host.changes("github~nobody~here").catch((e: unknown) => e);
    expect((unknown as HostError).status).toBe(404);
    expect((unknown as HostError).message).toBe("unknown workspace");
  });

  it("git calls onStderr once with the whole stderr", async () => {
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
    const chunks: string[] = [];
    const res = await host.git(ID, ["rev-parse", "--verify", "nope"], { onStderr: (c) => chunks.push(c) });
    expect(res.exitCode).not.toBe(0);
    expect(chunks).toEqual([res.stderr]);
  });

  it("proxies the run's page with the token, and only with it", async () => {
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
    const top = (await host.git(ID, ["rev-parse", "--show-toplevel"])).stdout.trim();
    let sawAuth: string | undefined = "unset";
    let sawHost: string | undefined;
    const page = http.createServer((req, res) => {
      sawAuth = req.headers.authorization;
      sawHost = req.headers.host;
      if (req.url === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runId: RUN_ID }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
    const port = (page.address() as AddressInfo).port;
    try {
      const runDir = path.join(top, ".graph-execution", RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, host: os.hostname() }));
      const target = host.viewTarget(ID, RUN_ID);
      expect(target.url).toBe(`${agent.url}/agent/v1/view/${encodeURIComponent(ID)}/${RUN_ID}`);
      const res = await fetch(`${target.url}/state`, { headers: target.headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runId: RUN_ID });
      expect(sawAuth).toBeUndefined();
      expect(sawHost).toBe(`127.0.0.1:${port}`);
      const denied = await fetch(`${target.url}/state`);
      expect(denied.status).toBe(401);
      const badRun = await fetch(`${agent.url}/agent/v1/view/${ID}/%2Enope/state`, { headers: target.headers });
      expect(badRun.status).toBe(400);
      const badWs = await fetch(`${agent.url}/agent/v1/view/github~no~ws/${RUN_ID}/state`, { headers: target.headers });
      expect(badWs.status).toBe(404);
      await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: 999_999_999, host: os.hostname() }));
      const gone = await fetch(`${target.url}/state`, { headers: target.headers });
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ error: "the run's page is not running" });
    } finally {
      await new Promise<void>((r) => page.close(() => r()));
    }
  });

  it.skipIf(process.platform === "win32")("serves PTYs: output, input, resize, exit code", async () => {
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
    const proc = await host.spawnPty({
      workspaceId: ID,
      argv: ["/bin/sh", "-c", 'printf ready; read line; stty size; echo "got:$line"; exit 5'],
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.process).toBeUndefined();
    let out = "";
    const waitFor = (s: string) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (out.includes(s)) resolve();
        };
        proc.onData((d) => {
          out += d;
          check();
        });
        check();
      });
    const exited = new Promise<number>((r) => proc.onExit((e) => r(e.exitCode)));
    await waitFor("ready");
    proc.resize(100, 30);
    await new Promise((r) => setTimeout(r, 100));
    proc.write("hello\r");
    expect(await exited).toBe(5);
    expect(out).toContain("got:hello");
    expect(out).toContain("30 100");
  });

  it.skipIf(process.platform === "win32")("kill stops the PTY; a second attach is refused", async () => {
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
    const res = await fetch(`${agent.url}/agent/v1/pty`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: ID, argv: ["/bin/sh", "-c", "sleep 30"], env: {}, cols: 80, rows: 24 }),
    });
    const { id } = (await res.json()) as { id: string };
    const url = `${agent.url.replace(/^http/, "ws")}/agent/v1/pty/${id}`;
    const opts = { headers: { authorization: `Bearer ${token}` } } as unknown as string[];
    const first = new WebSocket(url, opts);
    await new Promise((r) => first.addEventListener("open", r));
    const second = new WebSocket(url, opts);
    const code = await new Promise<number>((r) => second.addEventListener("close", (e) => r(e.code)));
    expect(code).toBe(4409);
    const exit = new Promise<unknown>((r) =>
      first.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as { type: string };
        if (m.type === "exit") r(m);
      }),
    );
    first.send(JSON.stringify({ type: "kill" }));
    expect(await exit).toMatchObject({ type: "exit" });
    const unknown = new WebSocket(`${agent.url.replace(/^http/, "ws")}/agent/v1/pty/nope`, opts);
    expect(await new Promise<number>((r) => unknown.addEventListener("close", (e) => r(e.code)))).toBe(4404);
  });
});
