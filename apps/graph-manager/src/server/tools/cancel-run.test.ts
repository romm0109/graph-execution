import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app.js";
import { setSandboxLookup } from "../runs.js";
import type { TerminalInfo } from "../terminals.js";
import { resolveWorkspace } from "../workspaces.js";
import { cancelRunTool } from "./cancel-run.js";
import { TOKEN, toolApp, writeRun, type ToolApp } from "./tool-test-helpers.js";

const RUN = "gm-20261108-100000-aaaa";

let t: ToolApp;
let server: http.Server | undefined;
let seen: { method?: string; url?: string; host?: string; origin?: string }[];

/** A run page whose POST /abort answers `status`; on 200 it marks state.json aborted, like the engine. */
async function fakePage(runDir: string, status: number): Promise<number> {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin });
    const { port } = server!.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(421).end("bad host");
    if (req.method !== "GET" && req.headers.origin) return void res.writeHead(403).end("bad origin");
    if (req.url === "/abort" && req.method === "POST") {
      void (async () => {
        if (status === 200) {
          const file = path.join(runDir, "state.json");
          const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
          await writeFile(file, JSON.stringify({ ...state, status: "aborted" }));
          await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: "http://127.0.0.1:1/", pid: 2 ** 22 + 12345 }));
        }
        const body = status === 200 ? { ok: true } : { error: "the run has ended" };
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      })();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));
  return port;
}

beforeEach(async () => {
  seen = [];
  t = await toolApp();
});
afterEach(async () => {
  setSandboxLookup(undefined);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await t.cleanup();
});

describe.skipIf(process.platform === "win32")("cancel_run", () => {
  it("is listed", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/internal/tools", headers: { authorization: `Bearer ${TOKEN}` } });
    const names = (res.json() as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["cancel_run", "resume_run"]));
  });

  it("aborts a live run through its page", async () => {
    const runDir = await writeRun(t.wsDir, RUN, { status: "running" });
    const port = await fakePage(runDir, 200);
    expect(await t.call("cancel_run", { runId: RUN })).toEqual({ text: `Stopped run ${RUN}. Resume it with resume_run.` });
    expect(seen).toEqual([{ method: "POST", url: "/abort", host: `127.0.0.1:${port}`, origin: undefined }]);
    const runs = await t.call("list_runs", {});
    expect(runs.text.split("\n").find((l) => l.includes(RUN))).toContain("| aborted |");
  });

  it("says not running when the page answers 409", async () => {
    const runDir = await writeRun(t.wsDir, RUN, { status: "failed" });
    await fakePage(runDir, 409);
    const r = await t.call("cancel_run", { runId: RUN });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(new RegExp(`^run ${RUN} is not running \\(.+\\)$`));
  });

  it("says not running for a finished run", async () => {
    await writeRun(t.wsDir, RUN, { status: "applied" });
    expect(await t.call("cancel_run", { runId: RUN })).toEqual({ isError: true, text: `run ${RUN} is not running (applied)` });
  });

  it("refuses an unknown run and a terminal outside workspaces", async () => {
    expect(await t.call("cancel_run", { runId: "gm-20261108-100000-zzzz" })).toEqual({ isError: true, text: "unknown run gm-20261108-100000-zzzz" });
    expect(await t.call("cancel_run", { runId: "../x" })).toEqual({ isError: true, text: "unknown run ../x" });
    expect(await t.call("cancel_run", { runId: RUN }, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });

  it("stops the sandbox of a sandboxed run whose page does not answer", async () => {
    await writeRun(t.wsDir, RUN, { status: "running" });
    // A port nothing listens on.
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    setSandboxLookup({ pageOf: async () => ({ url: `http://127.0.0.1:${port}/`, pid: 1, upstream: { host: "127.0.0.1", port, token: "s" } }) });
    const stops: string[] = [];
    const sandboxes = {
      recordOf: (wsId: string, runId: string) => (runId === RUN ? { wsId, runId } : undefined),
      stop: async (wsId: string, runId: string) => (stops.push(`${wsId}/${runId}`), true),
    };
    const ws = resolveWorkspace(t.config.workspacesDir, t.wsId)!;
    const r = await cancelRunTool.run(
      { runId: RUN },
      {
        ctx: { config: t.config, sandboxes } as unknown as AppContext,
        terminal: { id: "t9", title: "t", cwd: t.wsDir, status: "idle", createdAt: "x" } as unknown as TerminalInfo,
        workspace: ws,
        cwd: t.wsDir,
      },
    );
    expect(r).toEqual({ text: `Stopped run ${RUN}. Resume it with resume_run.` });
    expect(stops).toEqual([`${t.wsId}/${RUN}`]);
  });

  it("stops the sandbox of a sandboxed run whose page can't be found (F3)", async () => {
    await writeRun(t.wsDir, RUN, { status: "running" });
    setSandboxLookup({ pageOf: async () => null });
    const stops: string[] = [];
    const sandboxes = {
      recordOf: (wsId: string, runId: string) => (runId === RUN ? { wsId, runId } : undefined),
      stop: async (wsId: string, runId: string) => (stops.push(`${wsId}/${runId}`), true),
    };
    const r = await cancelRunTool.run(
      { runId: RUN },
      {
        ctx: { config: t.config, sandboxes } as unknown as AppContext,
        terminal: { id: "t9", title: "t", cwd: t.wsDir, status: "idle", createdAt: "x" } as unknown as TerminalInfo,
        workspace: resolveWorkspace(t.config.workspacesDir, t.wsId)!,
        cwd: t.wsDir,
      },
    );
    expect(r).toEqual({ text: `Stopped run ${RUN}. Resume it with resume_run.` });
    expect(stops).toEqual([`${t.wsId}/${RUN}`]);
  });
});
