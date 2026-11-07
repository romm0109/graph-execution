import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers.js";
import { readCachedView, toCachedView, ViewCache, viewPath } from "./viewcache.js";

const node = (status: string, extra: Record<string, unknown> = {}) => ({ status, attempt: 1, attempts: 3, label: "x", ...extra });

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    runId: "r1",
    nodes: {
      "1": node("merged", {
        startedAt: 1000,
        endedAt: 5000,
        changes: { files: [{ path: "a.ts", added: 10, deleted: 2 }], total: { added: 10, deleted: 2, files: 1 } },
      }),
      "2": node("failed", { attempt: 3, startedAt: 2000, endedAt: 9000 }),
    },
    agents: {
      gateFixer: node("pending", { attempt: 0 }),
      reviewer: node("done", { label: "code-r1" }),
      tester: node("done", {
        testPlan: { round: 1, cases: [{ id: "a", verdict: "pass" }, { id: "b", verdict: "fail" }, { id: "c", verdict: "pass" }] },
      }),
      fixer: node("pending", { attempt: 0 }),
    },
    gate: node("done"),
    merge: node("merged"),
    phase: { phase: "done", round: 1 },
    events: [{ time: "10:00:00", text: "secret log line" }],
    retryable: [],
    mergeable: false,
    failures: { "2": { error: "x".repeat(800), summary: undefined } },
    summary: {
      runId: "r1",
      branch: "graph/r1",
      exitCode: 0,
      fixPasses: 2,
      runDir: "/x",
      reports: [
        { round: 1, reviewer: "code", findings: [{}, {}] },
        { round: 1, reviewer: "test", findings: [{}] },
      ],
      merge: { target: "main", ok: true, files: [{ path: "a.ts", added: 1, deleted: 0 }] },
    },
    graph: { nodes: [], layers: [], parents: {} },
    provider: "fake",
    summaryContent: "# Summary",
    ...overrides,
  };
}

describe("toCachedView", () => {
  it("keeps statuses, times, totals and findings, and drops events and file lists", () => {
    const view = toCachedView(snapshot(), new Date("2026-11-06T10:00:00.000Z"));
    expect(view).toBeDefined();
    expect(view?.final).toBe(true);
    expect(view?.savedAt).toBe("2026-11-06T10:00:00.000Z");
    expect(view?.nodes["1"]).toEqual({ status: "merged", attempt: 1, attempts: 3, startedAt: 1000, endedAt: 5000, added: 10, deleted: 2, files: 1 });
    expect(view?.nodes["2"]?.status).toBe("failed");
    expect(view?.nodes["2"]?.error).toHaveLength(500);
    expect(view?.agents.reviewer?.status).toBe("done");
    expect(view?.summary).toEqual({ exitCode: 0, fixPasses: 2, findings: 3, merge: { target: "main", ok: true } });
    expect(view?.testPlan).toEqual({ cases: 3, pass: 2, fail: 1, blocked: 0 });
    expect(view?.phase).toEqual({ phase: "done", round: 1 });
    const text = JSON.stringify(view);
    expect(text).not.toContain("secret log line");
    expect(text).not.toContain("a.ts");
    expect(text).not.toContain("# Summary");
  });

  it("is not final while the run is going, and handles a human review wait", () => {
    const view = toCachedView(
      snapshot({ summary: undefined, phase: { phase: "human", round: 1 }, review: { waiting: true, round: 1, blocking: [{}, {}] } }),
    );
    expect(view?.final).toBe(false);
    expect(view?.summary).toBeUndefined();
    expect(view?.review).toEqual({ round: 1, blocking: 2 });
  });

  it("gives undefined for an input that is not a snapshot", () => {
    expect(toCachedView(undefined)).toBeUndefined();
    expect(toCachedView("nope")).toBeUndefined();
    expect(toCachedView({ runId: "r1" })).toBeUndefined();
  });
});

describe("viewPath / readCachedView", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  it("rejects ids that could escape the views folder", () => {
    expect(() => viewPath(dir, "../x", "r1")).toThrow();
    expect(() => viewPath(dir, "..", "r1")).toThrow();
    expect(() => viewPath(dir, "ws", "../r1")).toThrow();
    expect(viewPath(dir, "github~octo~hello", "r1")).toBe(path.join(dir, "views", "github~octo~hello", "r1.json"));
  });

  it("gives undefined for a missing file, a bad id or a broken file", async () => {
    expect(await readCachedView(dir, "ws", "r1")).toBeUndefined();
    expect(await readCachedView(dir, "../ws", "r1")).toBeUndefined();
    await mkdir(path.join(dir, "views", "ws"), { recursive: true });
    await writeFile(path.join(dir, "views", "ws", "r1.json"), "{not json");
    expect(await readCachedView(dir, "ws", "r1")).toBeUndefined();
  });
});

describe("ViewCache.tick", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: http.Server;
  let hits = 0;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    hits = 0;
    server = http.createServer((req, res) => {
      if (req.url === "/state") {
        hits++;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(snapshot()));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const wsDir = path.join(dir, "ws", "github", "octo", "hello");
    await mkdir(wsDir, { recursive: true });
    await execa("git", ["init", "-q"], { cwd: wsDir });
    const runDir = path.join(wsDir, ".graph-execution", "r1");
    await mkdir(runDir, { recursive: true });
    const state = stateSchema.parse({
      runId: "r1",
      provider: "fake",
      startingCommit: "0".repeat(40),
      integrationBranch: "graph/r1",
      specPath: "spec.md",
      tasksDir: path.join(dir, "tasks"),
      hashes: { config: "", tasks: "", spec: "" },
      tasks: { "1": { status: "merged", attempts: 1 } },
      review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
      createdAt: "2026-11-06T10:00:00.000Z",
      status: "running",
    });
    await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
    await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("writes the compact view of each live run, and skips an unchanged rewrite", async () => {
    const dataDir = path.join(dir, "data");
    const cache = new ViewCache({ dataDir, workspacesDir: path.join(dir, "ws") });
    await cache.tick();
    expect(hits).toBe(1);
    const file = viewPath(dataDir, "github~octo~hello", "r1");
    const first = await stat(file);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.runId).toBe("r1");
    expect(saved.final).toBe(true);
    expect(await readCachedView(dataDir, "github~octo~hello", "r1")).toEqual(saved);

    await new Promise((r) => setTimeout(r, 20));
    await cache.tick();
    expect(hits).toBe(2);
    expect((await stat(file)).mtimeMs).toBe(first.mtimeMs);

    // A fresh cache (a restart) also leaves the unchanged file alone.
    await new ViewCache({ dataDir, workspacesDir: path.join(dir, "ws") }).tick();
    expect((await stat(file)).mtimeMs).toBe(first.mtimeMs);
  });

  it("does not overlap ticks and swallows fetch errors", async () => {
    const cache = new ViewCache({
      dataDir: path.join(dir, "data"),
      workspacesDir: path.join(dir, "ws"),
      fetch: () => Promise.reject(new Error("down")),
    });
    const a = cache.tick();
    expect(cache.tick()).toBe(a);
    await expect(a).resolves.toBeUndefined();
    expect(await readCachedView(path.join(dir, "data"), "github~octo~hello", "r1")).toBeUndefined();
  });
});
