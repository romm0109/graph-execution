import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { advisorWorktree } from "../agents/advisor.js";
import { tempRepo } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, FAKE_SCRIPT_ENV, fakeScriptSchema } from "../providers/fake.js";
import { RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import type { BridgeTarget } from "../terminal/socket.js";
import { RunStore, type ViewState } from "../ui/store.js";
import { createWebServer, type WebServer } from "./server.js";
import { startWebUi, type WebUiHandle } from "./start.js";
import { webJsonPath } from "./webjson.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

const ESCALATION = { reason: "A or B is unclear", evidence: "spec line 3", questions: [{ id: "q1", question: "A or B?", suggestedOptions: ["A", "B"] }] };
const DRAFT = { escalationIds: ["E1"], action: "continue", guidance: "B" };
const SCRIPT = { "task:2": { attempts: [{ escalate: ESCALATION }] }, "advisor:E1": { attempts: [], draft: DRAFT } };
type State = ViewState & { drafts: Record<string, number>; advisors: Record<string, string> };
type Frame = { type: string; data?: string; code?: number };

/** A WebSocket client that keeps every frame it receives. */
function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const frames: Frame[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Frame));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  const text = (): string => frames.map((f) => f.data ?? "").join("");
  const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${what}; got ${JSON.stringify(text())}`);
  };
  return { ws, frames, opened, closed, text, waitFor };
}

/** The status the server refused an upgrade with. */
function refusedWith(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("error", () => undefined);
    ws.on("open", () => reject(new Error("the upgrade was accepted")));
  });
}

describe.skipIf(process.platform === "win32")("web advisor", () => {
  let repo: string;
  let scriptDir: string;
  const before = process.env[FAKE_SCRIPT_ENV];
  beforeEach(async () => {
    repo = await tempRepo();
    // The fake advisor is a separate process: it reads the script from the file named in the env.
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "advisor-script-"));
    const file = path.join(scriptDir, "script.json");
    writeFileSync(file, JSON.stringify(SCRIPT));
    process.env[FAKE_SCRIPT_ENV] = file;
  });
  afterEach(async () => {
    if (before === undefined) delete process.env[FAKE_SCRIPT_ENV];
    else process.env[FAKE_SCRIPT_ENV] = before;
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(scriptDir, { recursive: true, force: true });
  });

  it("talks to the advisor through the terminal, which writes the draft and applies it with graph-execution resolve", async () => {
    const provider = createFakeProvider(fakeScriptSchema.parse(SCRIPT));
    const events = new RunEmitter();
    const seen: string[] = [];
    events.on("escalation:resolved", ({ ids }) => seen.push(`resolved ${ids.join(",")}`));
    events.on("escalation:advisor", ({ id, status }) => seen.push(`advisor ${id} ${status}`));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log: () => {} });
    let web: WebUiHandle | undefined;
    const done = run(ctx, await loadTasks(fixture("diamond")), {
      specPath: fixture("spec.md"),
      tasksDir: fixture("diamond"),
      log: () => {},
      concurrency: 1,
      retry: new RetryHub(),
      events,
      ui: async (o) => {
        web = await startWebUi(o);
        // As the `--web` CLI does: `graph-execution resolve` finds the live page here.
        await writeFile(webJsonPath(ctx.runDir), JSON.stringify({ url: web.url, pid: process.pid }));
        return web;
      },
    });
    const state = async (): Promise<State | undefined> => {
      if (!web) return undefined;
      const res = await fetch(`${web.url}state`).catch(() => undefined);
      return res ? ((await res.json()) as State) : undefined;
    };
    const until = async (pred: (s: State) => boolean): Promise<State> => {
      for (let i = 0; i < 600; i++) {
        const s = await state();
        if (s && pred(s)) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("timeout");
    };
    await until((s) => (s.escalations ?? []).some((e) => e.id === "E1" && e.status === "open"));

    expect((await fetch(`${web!.url}escalations/E9/advisor`, { method: "POST" })).status).toBe(404);
    const res = await fetch(`${web!.url}escalations/E1/advisor`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true });
    expect(existsSync(advisorWorktree(ctx.runDir, "E1"))).toBe(true);
    expect((await until((s) => s.advisors?.E1 === "running")).advisors).toEqual({ E1: "running" });

    const terminalUrl = `${web!.url.replace(/^http/, "ws")}escalations/E1/advisor/terminal`;
    // A client that connects once the advisor printed gets its output in the replay (as a reloaded page does).
    let client = connect(terminalUrl);
    await client.opened;
    await client.waitFor(() => client.text().includes("advisor ready (E1)"), "advisor ready");
    client.ws.close();
    client = connect(terminalUrl);
    await client.opened;
    await client.waitFor(() => client.frames.length > 0, "the replay");
    expect(client.frames[0]!.type).toBe("replay");
    expect(client.frames[0]!.data).toContain("advisor ready (E1)");

    client.ws.send(JSON.stringify({ type: "input", data: "draft\r" }));
    for (let i = 0; i < 200; i++) {
      const d = (await (await fetch(`${web!.url}escalations/E1/draft`)).json()) as { draft: unknown };
      if (d.draft) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await (await fetch(`${web!.url}escalations/E1/draft`)).json()).toEqual({ draft: DRAFT });

    client.ws.send(JSON.stringify({ type: "input", data: "apply\r" }));
    // Resolving stops the advisor: its socket closes with 4404 and its worktree goes away.
    expect(await client.closed).toBe(4404);
    await until((s) => s.summary?.exitCode === 0);
    expect(client.text()).toContain("you said: apply");
    expect(seen).toContain("resolved E1");
    expect(seen.slice(-1)).toEqual(["advisor E1 exited"]);
    expect(existsSync(advisorWorktree(ctx.runDir, "E1"))).toBe(false);
    expect((await state())?.advisors).toEqual({});
    expect((await fetch(`${web!.url}escalations/E1/advisor`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${web!.url}close`, { method: "POST" })).status).toBe(200);
    expect((await done).exitCode).toBe(0);
  }, 60_000);
});

describe("advisor terminal upgrade checks", () => {
  let web: WebServer | undefined;
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(path.join(os.tmpdir(), "advisor-upgrade-"));
    mkdirSync(path.join(runDir, "escalations"), { recursive: true });
  });
  afterEach(async () => {
    await web?.close();
    web = undefined;
    await rm(runDir, { recursive: true, force: true });
  });

  /** A stand-in terminal for E1: it replays "hello" and records the input. */
  const start = async (token?: string) => {
    const input: string[] = [];
    const target = {
      attach: (): ReturnType<BridgeTarget["attach"]> => ({ replay: "hello", write: (s: string) => void input.push(s), resize: () => {}, detach: () => {} }),
    };
    const store = new RunStore(new RunEmitter(), { taskIds: ["a"], attempts: 3 });
    web = await createWebServer({
      store,
      meta: { layers: [["a"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      runDir,
      advisors: { start: async () => {}, restart: async () => {}, get: (id) => (id === "E1" ? target : undefined), statuses: () => ({ E1: "running" }) },
      ...(token ? { listen: { host: "127.0.0.1", port: 0, token } } : {}),
    });
    return { url: (id: string) => `ws://127.0.0.1:${web!.port}/escalations/${id}/advisor/terminal`, input };
  };

  it("checks Origin and Host, and closes an unknown terminal with 4404", async () => {
    const { url, input } = await start();
    expect(await refusedWith(url("E1"), { origin: "http://evil.example" })).toBe(403);
    expect(await refusedWith(url("E1"), { host: "evil.example" })).toBe(421);
    expect(await refusedWith(`ws://127.0.0.1:${web!.port}/escalations/E1/nope`, {})).toBe(404);
    const unknown = connect(url("E2"));
    expect(await unknown.closed).toBe(4404);

    const ok = connect(url("E1"), { origin: `http://127.0.0.1:${web!.port}` });
    await ok.opened;
    await ok.waitFor(() => ok.frames.length > 0, "the replay");
    expect(ok.frames[0]).toEqual({ type: "replay", data: "hello" });
    ok.ws.send(JSON.stringify({ type: "input", data: "x" }));
    await ok.waitFor(() => input.length > 0, "the input");
    expect(input).toEqual(["x"]);
    const body = (await (await fetch(`${web!.url}state`)).json()) as { advisors: unknown };
    expect(body.advisors).toEqual({ E1: "running" });
    // Closing the server closes its terminal sockets.
    await web!.close();
    web = undefined;
    await ok.closed;
  });

  it("requires the page token when one is set", async () => {
    const { url } = await start("s3cret");
    expect(await refusedWith(url("E1"), {})).toBe(401);
    expect(await refusedWith(url("E1"), { "x-graph-execution-token": "wrong!" })).toBe(401);
    const ok = connect(url("E1"), { "x-graph-execution-token": "s3cret" });
    await ok.opened;
    ok.ws.close();
  });

  it("answers the advisor routes: 404 unknown, 409 resolved, 501 when the run has none", async () => {
    const rec = (id: string, status: string) =>
      writeFile(
        path.join(runDir, "escalations", `${id}.json`),
        JSON.stringify({ id, node: "a", source: "agent", attempt: 1, createdAt: "x", status, reason: "r", evidence: "e", questions: [{ id: "q1", question: "?" }] }),
      );
    await rec("E1", "open");
    await rec("E2", "resolved");
    const store = new RunStore(new RunEmitter(), { taskIds: ["a"], attempts: 3 });
    web = await createWebServer({ store, meta: { layers: [["a"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 }, onAbort: () => {}, onClose: () => {}, runDir });
    const post = async (p: string) => {
      const res = await fetch(`${web!.url}${p}`, { method: "POST" });
      return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
    };
    expect((await post("escalations/E9/advisor")).status).toBe(404);
    expect(await post("escalations/E2/advisor")).toMatchObject({ status: 409, body: { error: { code: "not_open" } } });
    expect(await post("escalations/E1/advisor/restart")).toMatchObject({ status: 501, body: { error: { code: "unavailable" } } });
  });
});
