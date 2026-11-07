import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph, failureOf, layersOf, listRuns, runDetail, sumNumstat, taskTitle } from "./runs.js";
import type { CachedView } from "./viewcache.js";
import { tempDir } from "./test-helpers.js";
import { resolveWorkspace } from "./workspaces.js";

let dir: string;
let cleanup: () => Promise<void>;
let wsDir: string;
let tasksDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout;
}

const commit = (cwd: string, msg: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", msg);

async function writeRunState(overrides: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(wsDir, ".graph-execution", "r1", "state.json"), JSON.stringify(state(overrides)));
}

function state(overrides: Record<string, unknown> = {}) {
  return stateSchema.parse({
    runId: "r1",
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: "graph/r1",
    specPath: "spec.md",
    tasksDir,
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "merged", attempts: 1 }, "2": { status: "failed", attempts: 2 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-06T10:00:00.000Z",
    status: "failed",
    ...overrides,
  });
}

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  wsDir = path.join(dir, "ws", "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  await git(wsDir, "init", "-q");
  await git(wsDir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  tasksDir = path.join(dir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, "1.json"), JSON.stringify({ id: "1", content: "# Base\n\nSet up.", dependencies: [] }));
  await writeFile(path.join(tasksDir, "2.json"), JSON.stringify({ id: "2", content: "Feature A.", dependencies: ["1"] }));
  await writeFile(path.join(tasksDir, "test-plan.json"), JSON.stringify({ checks: [] }));
  const runDir = path.join(wsDir, ".graph-execution", "r1");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state()));
});

afterEach(async () => {
  await cleanup();
});

describe("listRuns", () => {
  it("lists the run with its status, provider and task counts", async () => {
    const runs = await listRuns(path.join(dir, "ws"));
    expect(runs).toEqual([
      {
        workspaceId: "github~octo~hello",
        type: "run",
        id: "r1",
        status: "failed",
        kind: "unfinished",
        live: false,
        createdAt: "2026-11-06T10:00:00.000Z",
        provider: "fake",
        taskCounts: { merged: 1, failed: 1 },
        failure: "task 2 failed",
      },
    ]);
  });

  it("adds the stored PR of a run", async () => {
    const prs = { "github~octo~hello/r1": { url: "https://github.com/octo/hello/pull/3", number: 3, forge: "github" as const, branch: "gm/r1", createdAt: "x" } };
    const [run] = await listRuns(path.join(dir, "ws"), prs);
    expect(run?.pr).toEqual({ url: "https://github.com/octo/hello/pull/3", number: 3, forge: "github" });
    const [other] = await listRuns(path.join(dir, "ws"), { "github~octo~hello/r2": prs["github~octo~hello/r1"] });
    expect(other?.pr).toBeUndefined();
  });

  it("takes the failure reason from the cached view of the run page", async () => {
    const dataDir = path.join(dir, "data");
    const view = (extra: Record<string, unknown>) => ({ version: 1, runId: "r1", savedAt: "x", final: true, phase: { phase: "done" }, nodes: {}, agents: {}, ...extra });
    const write = async (v: unknown) => {
      await mkdir(path.join(dataDir, "views", "github~octo~hello"), { recursive: true });
      await writeFile(path.join(dataDir, "views", "github~octo~hello", "r1.json"), JSON.stringify(v));
    };
    await write(view({ gate: { status: "failed" } }));
    expect((await listRuns(path.join(dir, "ws"), undefined, dataDir))[0]?.failure).toBe("validation failed");
    await write(view({ summary: { exitCode: 1, fixPasses: 0, findings: 0, abort: { step: "review", message: "x" } } }));
    expect((await listRuns(path.join(dir, "ws"), undefined, dataDir))[0]?.failure).toBe("review failed");
  });

  it("returns no runs for a workspace without .graph-execution", async () => {
    const other = path.join(dir, "ws", "github", "octo", "empty");
    await mkdir(other, { recursive: true });
    await git(other, "init", "-q");
    const runs = await listRuns(path.join(dir, "ws"));
    expect(runs.map((r) => r.id)).toEqual(["r1"]);
  });

  it("marks a run live and gives its view URL while web.json holds a live pid", async () => {
    await writeFile(path.join(wsDir, ".graph-execution", "r1", "web.json"), JSON.stringify({ url: "http://127.0.0.1:1/", pid: process.pid }));
    const [run] = await listRuns(path.join(dir, "ws"));
    expect(run?.live).toBe(true);
    expect(run?.viewUrl).toBe("/runs/github~octo~hello/r1/view/");
  });
});

describe("failureOf", () => {
  const view = (extra: Record<string, unknown> = {}) =>
    ({ version: 1, runId: "r1", savedAt: "x", final: true, phase: { phase: "done" }, nodes: {}, agents: {}, ...extra }) as unknown as CachedView;

  it("is undefined unless the run failed or was aborted", () => {
    expect(failureOf("applied", view({ gate: { status: "failed" } }))).toBeUndefined();
    expect(failureOf("running")).toBeUndefined();
  });

  it("labels the failed step of the cached view", () => {
    expect(failureOf("failed", view({ gate: { status: "failed" } }))).toBe("validation failed");
    expect(failureOf("failed", view({ nodes: { "1": { status: "merged" }, "3": { status: "failed" } } }))).toBe("task 3 failed");
    expect(failureOf("failed", view({ agents: { tester: { status: "failed" } } }))).toBe("review failed");
    expect(failureOf("failed", view({ merge: { status: "failed" } }))).toBe("apply failed");
    expect(failureOf("failed", view({ summary: { exitCode: 1, fixPasses: 0, findings: 0, merge: { target: "main", ok: false } } }))).toBe("apply failed");
    expect(failureOf("failed", view({ summary: { exitCode: 1, fixPasses: 0, findings: 0, abort: { step: "plan", message: "m" } } }))).toBe("plan failed");
    expect(failureOf("aborted", view())).toBe("aborted");
    expect(failureOf("aborted", view({ nodes: { "1": { status: "merged" }, "4": { status: "running" } } }))).toBe("aborted at task 4");
    expect(failureOf("aborted", view({ nodes: { "4": { status: "failed" } } }))).toBe("aborted at task 4");
    expect(failureOf("failed", view())).toBeUndefined();
  });

  it("falls back to state.json without a cached view", () => {
    expect(failureOf("failed", undefined, state())).toBe("task 2 failed");
    expect(failureOf("failed", undefined, state({ tasks: { "1": { status: "merged", attempts: 1 } } }))).toBe("failed");
    expect(failureOf("aborted", undefined, state({ tasks: {} }))).toBe("aborted");
    expect(failureOf("failed")).toBe("failed");
  });

});

describe("runDetail", () => {
  it("builds the layered graph from the task files", async () => {
    const ws = resolveWorkspace(path.join(dir, "ws"), "github~octo~hello")!;
    const detail = await runDetail(ws, "r1");
    expect(detail?.state?.runId).toBe("r1");
    expect(detail?.graph).toEqual({
      nodes: [
        { id: "1", title: "Base", status: "merged" },
        { id: "2", title: "2", status: "failed" },
      ],
      edges: [["1", "2"]],
      layers: [["1"], ["2"]],
    });
  });

  it("is undefined for an unknown or invalid run id", async () => {
    const ws = resolveWorkspace(path.join(dir, "ws"), "github~octo~hello")!;
    expect(await runDetail(ws, "nope")).toBeUndefined();
    expect(await runDetail(ws, "../x")).toBeUndefined();
  });

  it("falls back to state.tasks without edges when the tasks folder is gone", async () => {
    const graph = await buildGraph(state({ tasksDir: path.join(dir, "missing") }));
    expect(graph.edges).toEqual([]);
    expect(graph.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(graph.layers).toEqual([["1", "2"]]);
  });
});

describe("runDetail task table and landed changes", () => {
  it("merges state, the cached view and the task files into rows ordered by layer", async () => {
    const dataDir = path.join(dir, "data");
    const view = {
      version: 1,
      runId: "r1",
      savedAt: "2026-11-06T10:10:00.000Z",
      final: true,
      phase: { phase: "done" },
      nodes: {
        "1": { status: "merged", attempts: 1, startedAt: 1000, endedAt: 131_000, added: 212, deleted: 4, files: 3 },
        "2": { status: "failed", attempts: 2, startedAt: 2000, endedAt: 50_000, error: "tsc: 4 errors" },
      },
      agents: { reviewer: { status: "merged" } },
      summary: { exitCode: 0, fixPasses: 3, findings: 3 },
    };
    await mkdir(path.join(dataDir, "views", "github~octo~hello"), { recursive: true });
    await writeFile(path.join(dataDir, "views", "github~octo~hello", "r1.json"), JSON.stringify(view));
    const ws = resolveWorkspace(path.join(dir, "ws"), "github~octo~hello")!;
    const detail = await runDetail(ws, "r1", dataDir);
    expect(detail?.view?.summary?.findings).toBe(3);
    expect(detail?.tasks).toEqual([
      { id: "1", title: "Base", status: "merged", attempts: 1, startedAt: 1000, endedAt: 131_000, added: 212, deleted: 4, deps: [] },
      { id: "2", title: "2", status: "failed", attempts: 2, startedAt: 2000, endedAt: 50_000, error: "tsc: 4 errors", deps: ["1"] },
    ]);
    expect(detail?.landed).toBeUndefined();
    // Without dataDir: no view, no times.
    const bare = await runDetail(ws, "r1");
    expect(bare?.view).toBeUndefined();
    expect(bare?.tasks?.[0]?.startedAt).toBeUndefined();
  });

  it("computes a merged task's lines from git without a cache, and skips commits that are gone", async () => {
    const base = (await git(wsDir, "rev-parse", "HEAD")).trim();
    await writeFile(path.join(wsDir, "a.txt"), "one\ntwo\nthree\n");
    await git(wsDir, "add", "a.txt");
    await commit(wsDir, "task 1");
    const merge = (await git(wsDir, "rev-parse", "HEAD")).trim();
    await writeRunState({
      tasks: {
        "1": { status: "merged", attempts: 1, baseSha: base, mergeCommit: merge },
        "2": { status: "merged", attempts: 1, baseSha: base, mergeCommit: "f".repeat(40) },
      },
    });
    const ws = resolveWorkspace(path.join(dir, "ws"), "github~octo~hello")!;
    const detail = await runDetail(ws, "r1", path.join(dir, "data"));
    expect(detail?.tasks?.[0]).toMatchObject({ id: "1", added: 3, deleted: 0 });
    expect(detail?.tasks?.[1]?.added).toBeUndefined();
  });

  it("counts the uncommitted files and lines of an applied run, outside .graph-execution", async () => {
    await writeFile(path.join(wsDir, "tracked.txt"), "a\nb\nc\n");
    await git(wsDir, "add", "tracked.txt");
    await commit(wsDir, "tracked");
    await writeFile(path.join(wsDir, "tracked.txt"), "a\nB\nc\nd\n");
    await mkdir(path.join(wsDir, "src"), { recursive: true });
    await writeFile(path.join(wsDir, "src", "new.ts"), "x\ny");
    await writeFile(path.join(wsDir, "blob.bin"), Buffer.from([1, 0, 2, 0]));
    await writeRunState({ status: "applied" });
    const ws = resolveWorkspace(path.join(dir, "ws"), "github~octo~hello")!;
    const detail = await runDetail(ws, "r1");
    // tracked.txt (+2 −1), src/new.ts (+2), blob.bin (binary: 0); .graph-execution/ is excluded.
    expect(detail?.landed).toEqual({ files: 3, added: 4, deleted: 1 });
  });

  it("sums numstat output and skips binary rows", () => {
    expect(sumNumstat("3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n")).toEqual({ added: 13, deleted: 1 });
  });
});

describe("helpers", () => {
  it("takes the first # heading as the title", () => {
    expect(taskTitle("intro\n## sub\n# Main title  \n# second")).toBe("Main title");
    expect(taskTitle("no heading")).toBeUndefined();
  });

  it("layers a diamond and puts a cycle last", () => {
    const deps = new Map([["1", []], ["2", ["1"]], ["3", ["1"]], ["4", ["2", "3"]]]);
    expect(layersOf(["1", "2", "3", "4"], deps)).toEqual([["1"], ["2", "3"], ["4"]]);
    expect(layersOf(["a", "b"], new Map([["a", ["b"]], ["b", ["a"]]]))).toEqual([["a", "b"]]);
  });
});
