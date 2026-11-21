import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunEmitter, type RunEnd } from "../runner/events.js";
import { createWebServer, type WebServer } from "../web/server.js";
import { graphModel } from "./model.js";
import { GRAPH_FILE, type LiveGraph, readRunGraph, toGraphData, writeGraphFile } from "./rungraph.js";
import { RunStore } from "./store.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

let runDir: string;
let web: WebServer | undefined;
beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), "rungraph-"));
});
afterEach(async () => {
  await web?.close();
  web = undefined;
  await rm(runDir, { recursive: true, force: true });
});

const LAYERS = [["a"], ["b", "c"]];
const PARENTS = { b: ["a"], c: ["a"] };

/** A live run: the store, the web server the run page reads, and graph.json in `runDir`. */
async function liveRun(opts: { reviewers?: { id: string; name: string }[]; humanReview?: boolean; mergeTarget?: string } = {}) {
  const events = new RunEmitter();
  const store = new RunStore(events, {
    taskIds: LAYERS.flat(),
    attempts: 3,
    ...(opts.reviewers ? { reviewers: opts.reviewers, customReviewers: true } : {}),
  });
  const meta = { provider: "fake", humanReview: opts.humanReview === true, layers: LAYERS, parents: PARENTS, ...(opts.mergeTarget ? { mergeTarget: opts.mergeTarget } : {}) };
  web = await createWebServer({
    store,
    meta: { ...meta, runId: "r1", startedAt: 1 },
    onAbort: () => undefined,
    onClose: () => undefined,
  });
  const file = writeGraphFile(store, runDir, meta);
  /** What the run page draws now (GET /state), as GraphData. */
  const drawn = async () => {
    const body = (await (await fetch(`${web!.url}state`)).json()) as { graph: LiveGraph };
    return toGraphData(body.graph, "fake");
  };
  /** readRunGraph after graph.json caught up. */
  const read = async () => {
    await file.flush();
    return readRunGraph(runDir);
  };
  return { events, store, drawn, read, file };
}

const node = (g: Awaited<ReturnType<typeof readRunGraph>>, id: string) => g.nodes.find((n) => n.id === id);

describe("readRunGraph", () => {
  it("gives the run page's graph in every phase: tasks, gate with validation fixer, reviewers, fixer, done", async () => {
    const r = await liveRun({ mergeTarget: "main" });
    const check = async () => {
      const g = await r.read();
      expect(g).toEqual(await r.drawn());
      // The same nodes and edges graphModel() gives the web view.
      const model = graphModel({ layers: LAYERS, parents: PARENTS, state: r.store.getState(), mergeTarget: "main" });
      expect(g.nodes.map((n) => n.id).sort()).toEqual([...model.nodes.keys()].sort());
      const edges = model.layers.flat().flatMap((to) => (model.parents[to] ?? []).filter((f) => model.nodes.has(f)).map((from) => ({ from, to })));
      expect([...g.edges].sort((x, y) => (x.from + x.to).localeCompare(y.from + y.to))).toEqual(
        edges.sort((x, y) => (x.from + x.to).localeCompare(y.from + y.to)),
      );
      return g;
    };

    // Tasks running.
    r.events.emit("task:start", { taskId: "a" });
    let g = await check();
    expect(node(g, "a")).toMatchObject({ status: "running", attempt: 1, provider: "fake", title: "a" });
    expect(node(g, "a")!.startedAt).toBeTypeOf("number");
    expect(node(g, "b")).toMatchObject({ status: "pending" });
    expect(g.edges).toContainEqual({ from: "a", to: "b" });
    expect(g.edges).toContainEqual({ from: "b", to: "@gate" });
    expect(node(g, "@gate-fixer")).toBeUndefined();
    expect(node(g, "@merge")).toMatchObject({ title: "apply → main" });

    // The gate failed: the validation fixer shows between the gate and the reviewers.
    for (const id of ["a", "b", "c"]) r.events.emit("task:merged", { taskId: id, mergeCommit: "x" });
    r.events.emit("phase:change", { phase: "validate" });
    r.events.emit("agent:start", { agent: "gateFixer", label: "validation fixer" });
    r.events.emit("agent:status", { agent: "gateFixer", status: "fixing", round: 1, rounds: 3 });
    g = await check();
    expect(node(g, "@gate")).toMatchObject({ status: "running" });
    expect(node(g, "@gate-fixer")).toMatchObject({ status: "fixing", detail: "fixing 1/3", title: "validation fixer" });
    expect(g.edges).toContainEqual({ from: "@gate", to: "@gate-fixer" });
    expect(g.edges).toContainEqual({ from: "@gate-fixer", to: "@reviewer" });
    r.events.emit("agent:status", { agent: "gateFixer", status: "validating", round: 1, rounds: 3 });
    g = await check();
    expect(node(g, "@gate-fixer")).toMatchObject({ status: "validating", detail: "checking fix 1/3" });

    // Reviewers running.
    r.events.emit("agent:end", { agent: "gateFixer", label: "validation fixer", ok: true });
    r.events.emit("phase:change", { phase: "review", round: 1 });
    r.events.emit("agent:start", { agent: "reviewer", label: "code-r1" });
    r.events.emit("agent:start", { agent: "tester", label: "tester-r1" });
    g = await check();
    expect(node(g, "@gate")).toMatchObject({ status: "done" });
    expect(node(g, "@gate")!.endedAt).toBeTypeOf("number");
    expect(node(g, "@reviewer")).toMatchObject({ status: "running", title: "code reviewer" });
    expect(node(g, "@tester")).toMatchObject({ status: "running", title: "live tester" });

    // The fixer.
    r.events.emit("agent:end", { agent: "reviewer", label: "code-r1", ok: true });
    r.events.emit("agent:end", { agent: "tester", label: "tester-r1", ok: true });
    r.events.emit("phase:change", { phase: "fix", round: 1, fixPasses: 3 });
    r.events.emit("agent:start", { agent: "fixer", label: "fixer-1" });
    r.events.emit("nodeChanges", { nodeId: "@fixer", changes: { files: [], total: { added: 3, deleted: 1, files: 2 } } });
    g = await check();
    expect(node(g, "@fixer")).toMatchObject({ status: "running", changes: { added: 3, deleted: 1, files: 2 } });
    expect(g.edges).toContainEqual({ from: "@reviewer", to: "@fixer" });
    expect(g.edges).toContainEqual({ from: "@tester", to: "@fixer" });

    // Done: graph.json keeps the final graph after the run ends.
    r.events.emit("agent:end", { agent: "fixer", label: "fixer-1", ok: true });
    r.events.emit("merge:status", { status: "done" });
    r.events.emit("phase:change", { phase: "done" });
    r.events.emit("run:end", { runId: "r1", branch: "graph/r1", exitCode: 0, reports: [], fixPasses: 3, runDir } as unknown as RunEnd);
    await r.file.stop();
    g = await check();
    expect(g.nodes.every((n) => ["merged", "done", "skipped"].includes(n.status))).toBe(true);
    expect(node(g, "@merge")).toMatchObject({ status: "done" });
  });

  it("shows a reviewer from the reviewers file as its own node", async () => {
    const r = await liveRun({ reviewers: [{ id: "code", name: "Code" }, { id: "security", name: "Security" }] });
    r.events.emit("phase:change", { phase: "review", round: 1 });
    r.events.emit("agent:start", { agent: "security", label: "security-r1" });
    const g = await r.read();
    expect(g).toEqual(await r.drawn());
    expect(node(g, "@security")).toMatchObject({ title: "Security", status: "running" });
    expect(node(g, "@tester")).toBeUndefined();
    expect(g.edges).toContainEqual({ from: "@gate", to: "@security" });
    expect(g.edges).toContainEqual({ from: "@security", to: "@fixer" });
  });

  it("shows the human review between the fixer and the apply, like the run page", async () => {
    const r = await liveRun({ humanReview: true });
    r.events.emit("review:waiting", { round: 1, blocking: [] });
    const g = await r.read();
    expect(g).toEqual(await r.drawn());
    expect(node(g, "@human")).toMatchObject({ status: "human", detail: "waiting for you" });
    expect(g.edges).toContainEqual({ from: "@fixer", to: "@human" });
    expect(g.edges).toContainEqual({ from: "@human", to: "@merge" });
    expect(g.edges).not.toContainEqual({ from: "@fixer", to: "@merge" });
  });

  it("follows a resolution that changed the task graph", async () => {
    const r = await liveRun();
    r.events.emit("graph:changed", { taskIds: ["a", "d"], layers: [["a"], ["d"]], parents: { d: ["a"] } });
    const g = await r.read();
    expect(g).toEqual(await r.drawn());
    expect(g.nodes.filter((n) => !n.id.startsWith("@")).map((n) => n.id)).toEqual(["a", "d"]);
    expect(g.edges).toContainEqual({ from: "a", to: "d" });
  });

  it("reads without writing anything to the run directory", async () => {
    const r = await liveRun();
    await r.file.flush();
    const before = (await readdir(runDir)).sort();
    await readRunGraph(runDir);
    expect((await readdir(runDir)).sort()).toEqual(before);
  });

  describe("without graph.json", () => {
    it("gives empty GraphData for an empty run directory", async () => {
      expect(await readRunGraph(runDir)).toEqual({ nodes: [], edges: [] });
    });

    it("never throws on a half-written state.json or graph.json", async () => {
      await writeFile(path.join(runDir, "state.json"), '{"runId": "r1", "tasks": {"1": {"sta');
      await writeFile(path.join(runDir, GRAPH_FILE), '{"version": 1, "layers": [[');
      expect(await readRunGraph(runDir)).toEqual({ nodes: [], edges: [] });
      // The tasks copy is still there to read.
      await cp(fixture("diamond"), path.join(runDir, "context", "tasks"), { recursive: true });
      const g = await readRunGraph(runDir);
      expect(g.nodes.filter((n) => !n.id.startsWith("@")).map((n) => n.id)).toEqual(["1", "2", "3", "4"]);
    });

    it("draws the tasks of state.json with their statuses and the pipeline after them", async () => {
      await mkdir(path.join(runDir, "context"), { recursive: true });
      await cp(fixture("diamond"), path.join(runDir, "context", "tasks"), { recursive: true });
      await writeFile(
        path.join(runDir, "state.json"),
        JSON.stringify({
          runId: "r1",
          provider: "fake",
          status: "running",
          targetBranch: "main",
          tasks: { "1": { status: "merged", attempts: 1 }, "2": { status: "running", attempts: 1 }, "3": { status: "failed", attempts: 3 }, "4": { status: "pending", attempts: 0 } },
        }),
      );
      const g = await readRunGraph(runDir);
      expect(g.nodes.map((n) => [n.id, n.status])).toEqual([
        ["1", "merged"],
        ["2", "running"],
        ["3", "failed"],
        ["4", "pending"],
        ["@gate", "pending"],
        ["@reviewer", "pending"],
        ["@tester", "pending"],
        ["@fixer", "pending"],
        ["@merge", "pending"],
      ]);
      expect(g.edges).toContainEqual({ from: "1", to: "2" });
      expect(g.edges).toContainEqual({ from: "4", to: "@gate" });
      expect(node(g, "@merge")!.title).toBe("apply → main");
    });
  });
});
