// The run graph as the live web view draws it, shared by the web server (`GET /state`), the run's `graph.json` and
// `readRunGraph` (graph-execution/api). The node ids and the GraphData shape are public API, covered by semver.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameReplacing } from "../fs/rename.js";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { executionLayers } from "../graph/validate.js";
import { readRunReviewers, RUN_REVIEWERS_FILE } from "../review/reviewers.js";
import { RunEmitter } from "../runner/events.js";
import { HUMAN_NODE, MERGE_NODE } from "../runner/nodes.js";
import type { GraphData, GraphEdge, GraphNode as GraphDataNode, NodeStatus as GraphNodeStatus } from "../web/assets/graph.js";
import { graphModel } from "./model.js";
import { type NodeView, RunStore, type ViewState } from "./store.js";

/** The file in the run directory that holds the live graph, rewritten (atomically) whenever the run's store changes. */
export const GRAPH_FILE = "graph.json";

/** A node's view in the live graph: the human review's node has the `human` status and its own text. */
export type LiveNodeView = Omit<NodeView, "status"> & { status: NodeView["status"] | "human"; text?: string };

export interface LiveGraph {
  nodes: { id: string; title: string; view: LiveNodeView; detail?: string }[];
  layers: string[][];
  parents: Record<string, readonly string[]>;
}

/** What the live graph is made from: the store's state and the run's fixed facts. */
export interface LiveGraphInput {
  /** The task graph the run started with; `state.graph` replaces it once a resolution changed it. */
  layers: readonly (readonly string[])[];
  parents: Readonly<Record<string, readonly string[]>>;
  state: Pick<ViewState, "nodes" | "agents" | "gate" | "merge" | "reviewers" | "review" | "graph"> & { summary?: unknown };
  mergeTarget?: string;
  /** The run pauses for a human review before the apply: a `@human` node shows between the fixer and the apply. */
  humanReview?: boolean;
  /** The run is over (or the page has a fatal error): a human review that never started is "not reached". */
  ended?: boolean;
}

/** A node's status text, as the run page shows it in the panel (`retry 2/3`, `fixing 1/3`, `checking fix 1/3`). */
export function statusText(view: LiveNodeView): string {
  if (view.text) return view.text;
  if (view.status === "escalated") return "needs decision";
  if (view.status === "running" && view.attempt > 1) return `retry ${view.attempt}/${view.attempts}`;
  if (view.status === "fixing" && view.round !== undefined) return `fixing ${view.round}/${view.rounds ?? "?"}`;
  if (view.status === "validating" && view.round) return `checking fix ${view.round}/${view.rounds ?? "?"}`;
  return view.status;
}

/** The second line of a node's card: its status text, unless that is just the status or a retry (shown as `×N`). */
export function nodeDetail(view: LiveNodeView): string | undefined {
  const text = statusText(view);
  return text !== view.status && !text.startsWith("retry ") ? text : undefined;
}

/** The human review's node, from the wait and the last decision. */
function humanView(input: LiveGraphInput): LiveNodeView {
  const r = input.state.review;
  const base = { attempt: 0, attempts: 1, label: "human review" };
  if (r?.waiting) return { ...base, status: "human", text: `waiting for you${r.round > 1 ? ` · ${r.round}` : ""}` };
  if (r?.decision === "changes") return { ...base, status: "fixing", text: `changes, round ${r.round}` };
  if (r?.decision === "apply") return { ...base, status: "done", text: input.mergeTarget ? "approved" : "finished" };
  if (r?.decision === "drop") return { ...base, status: "skipped", text: "dropped" };
  if (input.state.summary !== undefined || input.ended) return { ...base, status: "skipped", text: "not reached" };
  return { ...base, status: "pending", text: "pending" };
}

/**
 * The graph the run page draws: `graphModel()` (tasks, gate, validation fixer, reviewers, fixer, apply), plus the
 * human review's node before the apply when the run pauses for one. Nodes come in display (layer) order.
 */
export function liveGraph(input: LiveGraphInput): LiveGraph {
  const tasks = input.state.graph ?? { layers: input.layers, parents: input.parents };
  const model = graphModel({ layers: tasks.layers, parents: tasks.parents, state: input.state, mergeTarget: input.mergeTarget });
  const nodes: LiveGraph["nodes"] = [...model.nodes].map(([id, n]) => ({ id, title: n.title, view: n.view, detail: nodeDetail(n.view) }));
  const merge = model.layers.findIndex((l) => l.includes(MERGE_NODE));
  if (!input.humanReview || merge < 0) return { nodes, layers: model.layers, parents: model.parents };
  const view = humanView(input);
  return {
    nodes: [...nodes, { id: HUMAN_NODE, title: "human review", view, detail: nodeDetail(view) }],
    layers: [...model.layers.slice(0, merge), [HUMAN_NODE], ...model.layers.slice(merge)],
    parents: { ...model.parents, [HUMAN_NODE]: model.parents[MERGE_NODE] ?? [], [MERGE_NODE]: [HUMAN_NODE] },
  };
}

/** `GraphData` (graph-execution/graph) of a live graph: nodes in display order, an edge per dependency drawn. */
export function toGraphData(graph: LiveGraph, provider?: string): GraphData {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: GraphDataNode[] = [];
  const edges: GraphEdge[] = [];
  for (const layer of graph.layers) {
    for (const id of layer) {
      const n = byId.get(id);
      if (!n) continue;
      const v = n.view;
      nodes.push({
        id,
        title: n.title,
        status: v.status as GraphNodeStatus,
        ...(provider ? { provider } : {}),
        ...(v.startedAt !== undefined ? { startedAt: v.startedAt } : {}),
        ...(v.endedAt !== undefined ? { endedAt: v.endedAt } : {}),
        attempt: v.attempt,
        ...(n.detail !== undefined ? { detail: n.detail } : {}),
        ...(v.changes ? { changes: { ...v.changes.total } } : {}),
      });
    }
  }
  const drawn = new Set(nodes.map((n) => n.id));
  for (const { id: to } of nodes) {
    for (const from of graph.parents[to] ?? []) if (drawn.has(from)) edges.push({ from, to });
  }
  return { nodes, edges };
}

// ---- graph.json ----

/** The content of `<runDir>/graph.json`: the store's state the graph is made from, and the run's fixed facts. */
export interface GraphFile {
  version: 1;
  provider: string;
  mergeTarget?: string;
  humanReview: boolean;
  layers: string[][];
  parents: Record<string, string[]>;
  state: LiveGraphInput["state"] & { ended: boolean };
  /** ms epoch of this write. */
  updatedAt: number;
}

export interface GraphFileMeta {
  provider: string;
  mergeTarget?: string;
  humanReview: boolean;
  layers: string[][];
  parents: Record<string, string[]>;
}

/** The part of the store's state `graph.json` keeps: no findings, failures or events. */
function graphFileOf(state: ViewState, meta: GraphFileMeta, now = Date.now()): GraphFile {
  const review = state.review
    ? { waiting: state.review.waiting, round: state.review.round, blocking: [], ...(state.review.decision ? { decision: state.review.decision } : {}) }
    : undefined;
  return {
    version: 1,
    ...meta,
    state: {
      nodes: state.nodes,
      agents: state.agents,
      gate: state.gate,
      merge: state.merge,
      reviewers: state.reviewers,
      ...(review ? { review } : {}),
      ...(state.graph ? { graph: state.graph } : {}),
      ended: state.summary !== undefined,
    },
    updatedAt: now,
  };
}

/** How long store changes are batched before `graph.json` is rewritten, in ms. */
export const GRAPH_WRITE_MS = 100;

/**
 * Keeps `<runDir>/graph.json` in step with `store`: written at once, then at most every `GRAPH_WRITE_MS` while the
 * store changes, each time to a temporary file renamed over the old one. `flush()` writes the latest state and waits
 * for it; `stop()` flushes and stops following the store. Write errors are ignored: the file is a view, never needed
 * by the run.
 */
export function writeGraphFile(
  store: Pick<RunStore, "getState" | "subscribe">,
  runDir: string,
  meta: GraphFileMeta,
): { flush(): Promise<void>; stop(): Promise<void> } {
  const file = path.join(runDir, GRAPH_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const text = JSON.stringify(graphFileOf(store.getState() as ViewState, meta));
    chain = chain
      .then(async () => {
        await writeFile(tmp, text);
        await renameReplacing(tmp, file);
      })
      .catch(() => undefined);
    return chain;
  };
  const unsubscribe = store.subscribe(() => {
    if (timer !== undefined) return;
    timer = setTimeout(() => void write(), GRAPH_WRITE_MS);
    timer.unref?.();
  });
  void write();
  return {
    flush: write,
    stop: async () => {
      unsubscribe();
      await write();
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isView = (v: unknown): v is NodeView => isRecord(v) && typeof v.status === "string" && typeof v.attempt === "number";

/** A `graph.json` that has every part the graph needs, else undefined. */
function parseGraphFile(text: string): GraphFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.layers) || !isRecord(raw.parents) || !isRecord(raw.state)) return undefined;
  const s = raw.state;
  if (!isRecord(s.nodes) || !isRecord(s.agents) || !isView(s.gate) || !isView(s.merge) || !Array.isArray(s.reviewers)) return undefined;
  if (!isView(s.agents.fixer) || !isView(s.agents.gateFixer)) return undefined;
  return raw as unknown as GraphFile;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The task statuses and fixed facts of a run from its state.json, or undefined when it cannot be read yet. */
interface SavedRun {
  provider?: string;
  targetBranch?: string;
  humanReview?: boolean;
  tasksSource?: string;
  tasksDir?: string;
  tasks: Record<string, { status?: string; attempts?: number }>;
  status?: string;
}

function parseState(text: string | undefined): SavedRun | undefined {
  if (text === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) return undefined;
    return { ...(raw as Omit<SavedRun, "tasks">), tasks: isRecord(raw.tasks) ? (raw.tasks as SavedRun["tasks"]) : {} };
  } catch {
    return undefined;
  }
}

async function tryLoadTasks(dir: string | undefined): Promise<Task[] | undefined> {
  if (dir === undefined || !existsSync(dir)) return undefined;
  try {
    return await loadTasks(dir);
  } catch {
    return undefined;
  }
}

/**
 * The graph of a run that has no `graph.json` yet (its first moments, or a run from before 2.0.7): the store a fresh
 * run would start with, fed the task statuses of state.json.
 */
async function graphFromRunFolder(runDir: string): Promise<GraphData> {
  const saved = parseState(await readText(path.join(runDir, "state.json")));
  const tasks =
    (saved?.tasksSource === "run" ? await tryLoadTasks(path.join(runDir, "tasks")) : undefined) ??
    (await tryLoadTasks(path.join(runDir, "context", "tasks"))) ??
    (await tryLoadTasks(saved?.tasksDir));
  const known = saved ? Object.keys(saved.tasks) : [];
  // Only the tasks of this run: a later edit of the folder must not add any.
  const runTasks = tasks ? (known.length > 0 ? tasks.filter((t) => known.includes(t.id)) : tasks) : undefined;
  let layers: string[][];
  let parents: Record<string, string[]>;
  try {
    if (!runTasks || runTasks.length === 0) throw new Error("no tasks");
    const ids = new Set(runTasks.map((t) => t.id));
    layers = executionLayers(runTasks).map((l) => l.map((t) => t.id));
    parents = Object.fromEntries(runTasks.map((t) => [t.id, t.dependencies.filter((d) => ids.has(d))]));
  } catch {
    layers = known.length > 0 ? [known] : [];
    parents = {};
  }
  if (!saved && layers.length === 0) return { nodes: [], edges: [] };

  let reviewers;
  try {
    reviewers = (await readRunReviewers(runDir)).map((r) => ({ id: r.id, name: r.name }));
  } catch {
    reviewers = undefined;
  }
  const taskStates = saved?.tasks ?? {};
  const events = new RunEmitter();
  const store = new RunStore(events, {
    taskIds: layers.flat(),
    merged: layers.flat().filter((id) => taskStates[id]?.status === "merged"),
    attempts: 1,
    ...(reviewers ? { reviewers } : {}),
    customReviewers: existsSync(path.join(runDir, RUN_REVIEWERS_FILE)),
  });
  for (const id of layers.flat()) {
    const status = taskStates[id]?.status;
    if (status === "running") events.emit("task:start", { taskId: id });
    else if (status === "validating" || status === "merging" || status === "escalated") {
      events.emit("task:start", { taskId: id });
      events.emit("task:status", { taskId: id, status });
    } else if (status === "failed") events.emit("task:failed", { taskId: id, error: undefined });
  }
  const state = store.getState();
  store.dispose();
  const mergeTarget = saved?.targetBranch;
  return toGraphData(
    liveGraph({
      layers,
      parents,
      state,
      ...(mergeTarget ? { mergeTarget } : {}),
      humanReview: saved?.humanReview === true,
      ended: saved?.status !== undefined && saved.status !== "running",
    }),
    saved?.provider,
  );
}

/**
 * The nodes and edges the run's live web view draws right now, read from its run directory only: no lock is taken
 * and nothing is written, so it works from another process while the run is live and after it ended. Node ids are
 * the task ids and the pipeline ids of src/runner/nodes.ts (`@gate`, `@gate-fixer`, `@reviewer`, `@tester`,
 * `@<reviewer id>`, `@fixer`, `@human`, `@merge`). A run directory with nothing readable yet gives empty GraphData;
 * it never throws on a file caught mid-write.
 */
export async function readRunGraph(runDir: string): Promise<GraphData> {
  const text = await readText(path.join(runDir, GRAPH_FILE));
  const file = text === undefined ? undefined : parseGraphFile(text);
  if (!file) return graphFromRunFolder(runDir);
  return toGraphData(
    liveGraph({
      layers: file.layers,
      parents: file.parents,
      state: file.state,
      ...(file.mergeTarget ? { mergeTarget: file.mergeTarget } : {}),
      humanReview: file.humanReview,
      ended: file.state.ended,
    }),
    file.provider,
  );
}
