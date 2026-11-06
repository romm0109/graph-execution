import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraph, layersOf, listRuns, runDetail, taskTitle } from "./runs.js";
import { tempDir } from "./test-helpers.js";
import { resolveWorkspace } from "./workspaces.js";

let dir: string;
let cleanup: () => Promise<void>;
let wsDir: string;
let tasksDir: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa("git", args, { cwd });
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
      },
    ]);
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
