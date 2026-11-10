import { open, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RUN_ID_PATTERN,
  RUNS_DIR,
  SUITE_FILE,
  isAlive,
  readWebJson,
  scan,
  stateSchema,
  suiteStateSchema,
  type RunEntry,
  type RunState,
} from "graph-execution/api";
import { execa } from "execa";
import { readCachedView, type CachedView } from "./viewcache.js";
import { listWorkspaces, type Workspace } from "./workspaces.js";

export interface RunSummary {
  workspaceId: string;
  type: "run" | "suite";
  id: string;
  status: string;
  kind: string;
  /** The run's own page server is up (`web.json` holds a live pid). */
  live: boolean;
  /** `/runs/<ws>/<id>/view/` while live. */
  viewUrl?: string;
  createdAt?: string;
  provider?: string;
  /** Tasks per status (runs only). */
  taskCounts?: Record<string, number>;
  /** The PR/MR graph-manager opened from this run. */
  pr?: RunPr;
  /** A short reason for a failed or aborted run, e.g. "validation failed". */
  failure?: string;
  /**
   * Set for a sandboxed run: while its container exists (`running`), or from state.json's `sandbox` once it is gone
   * (`gone: true`, with the image it ran in).
   */
  sandbox?: { running: boolean; image?: string; gone?: true };
}

export interface RunPr {
  url: string;
  number: number;
  forge: "github" | "gitlab";
}

/** Stored PRs keyed `${workspaceId}/${runId}` (the store's `prs`; extra fields are ignored). */
export type PrIndex = Record<string, RunPr>;

/** Where `listRuns` finds the extras of a summary: the stored PRs and the data dir with the cached views. */
export interface SummaryExtras {
  prs?: PrIndex;
  dataDir?: string;
}

export interface GraphNode {
  id: string;
  title: string;
  status: string;
}

export interface RunGraph {
  nodes: GraphNode[];
  edges: [string, string][];
  /** Node ids by topological layer: a node's dependencies are all in earlier layers. */
  layers: string[][];
}

/** One row of the run detail's task table. Times are epoch ms. */
export interface TaskRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  added?: number;
  deleted?: number;
  deps: string[];
  error?: string;
}

/** What an applied run left uncommitted in the workspace (outside `.graph-execution`). */
export interface Landed {
  files: number;
  added: number;
  deleted: number;
}

export interface RunDetail {
  summary: RunSummary;
  state?: RunState;
  graph?: RunGraph;
  /** graph-manager's cached copy of the run page's view model, when it saw the run live. */
  view?: CachedView;
  /** The tasks by layer, then id. */
  tasks?: TaskRow[];
  /** Only when the run is `applied`. */
  landed?: Landed;
}

export const isRunId = (id: string): boolean => RUN_ID_PATTERN.test(id);

export const viewUrlOf = (workspaceId: string, runId: string): string =>
  `/runs/${encodeURIComponent(workspaceId)}/${encodeURIComponent(runId)}/view/`;

export interface LivePage {
  url: string;
  pid: number;
  /**
   * Where the proxy connects; absent = 127.0.0.1:<port of url>. `hostPort` is the port of the `Host` header the
   * engine accepts when it differs from `port` (a port Docker published on the host); default `port`.
   */
  upstream?: { host: string; port: number; hostPort?: number; token?: string };
}

/** Maps a run folder to its sandbox page: undefined = not a sandboxed run; null = its container is not running. */
export interface SandboxLookup {
  pageOf(runDir: string): Promise<LivePage | null | undefined>;
}

let sandboxLookup: SandboxLookup | undefined;

/** Set by `buildApp` (graph-manager's `Sandboxes`), cleared when the app closes. */
export function setSandboxLookup(l: SandboxLookup | undefined): void {
  sandboxLookup = l;
}

/** Clears the lookup when it is still `l` (another app of the same process may have set its own since). */
export function clearSandboxLookup(l: SandboxLookup): void {
  if (sandboxLookup === l) sandboxLookup = undefined;
}

/** The sandbox answer for a run folder (see `SandboxLookup`); undefined when there is no lookup or it fails. */
async function sandboxPageOf(runDir: string): Promise<LivePage | null | undefined> {
  if (!sandboxLookup) return undefined;
  try {
    return await sandboxLookup.pageOf(runDir);
  } catch {
    return undefined;
  }
}

/** The page from `web.json`, when it was written on this host by a process that is alive. */
async function localPage(runDir: string): Promise<LivePage | undefined> {
  const web = await readWebJson(runDir);
  // Written in a container whose record is gone: its pid means nothing here.
  if (!web || (web.host !== undefined && web.host !== os.hostname())) return undefined;
  return isAlive(web.pid) ? { url: web.url, pid: web.pid } : undefined;
}

/** The run's page: its sandbox's while graph-manager knows one, else from `web.json` when its process is alive. */
export async function livePage(runDir: string): Promise<LivePage | undefined> {
  const s = await sandboxPageOf(runDir);
  if (s !== undefined) return s ?? undefined;
  return localPage(runDir);
}

async function readState(runDir: string): Promise<RunState | undefined> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readSuiteProvider(dir: string): Promise<string | undefined> {
  try {
    const parsed = suiteStateSchema.safeParse(JSON.parse(await readFile(path.join(dir, SUITE_FILE), "utf8")));
    return parsed.success ? parsed.data.provider : undefined;
  } catch {
    return undefined;
  }
}

function countTasks(state: RunState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of Object.values(state.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}

const isFailed = (status: string): boolean => status === "failed";
/** Task statuses of work in progress; in a run that has ended they mean the task was interrupted. */
const IN_FLIGHT = new Set(["running", "validating", "merging"]);

/**
 * A short label of why a failed or aborted run stopped: from graph-manager's cached view of its page when there is one,
 * else from `state.json`. Undefined for any other status.
 */
export function failureOf(status: string, view?: CachedView, state?: RunState): string | undefined {
  if (status !== "failed" && status !== "aborted") return undefined;
  if (status === "aborted") {
    // The user stopped it: name the task it stopped at, never "task N failed".
    const stopped = (statuses: [string, string][]) =>
      statuses.find(([, s]) => isFailed(s))?.[0] ?? statuses.find(([, s]) => IN_FLIGHT.has(s))?.[0];
    const fromView = view ? stopped(Object.entries(view.nodes).map(([id, n]) => [id, n.status])) : undefined;
    const task = fromView ?? (state ? stopped(Object.entries(state.tasks).map(([id, t]) => [id, t.status])) : undefined);
    return task !== undefined ? `aborted at task ${task}` : "aborted";
  }
  if (view) {
    if (view.gate && isFailed(view.gate.status)) return "validation failed";
    const task = Object.entries(view.nodes).find(([, n]) => isFailed(n.status))?.[0];
    if (task !== undefined) return `task ${task} failed`;
    if (Object.values(view.agents).some((a) => a && isFailed(a.status))) return "review failed";
    if ((view.merge && isFailed(view.merge.status)) || view.summary?.merge?.ok === false) return "apply failed";
    if (view.summary?.abort) return `${view.summary.abort.step} failed`;
    return undefined;
  }
  const task = state ? Object.entries(state.tasks).find(([, t]) => isFailed(t.status))?.[0] : undefined;
  if (task !== undefined) return `task ${task} failed`;
  return "failed";
}

/**
 * Whether a process still drives the run. A sandboxed run's lock is foreign (scan always takes it for live), so its
 * container decides: running while graph-manager knows it and Docker says it runs.
 */
function stillRunning(entry: RunEntry, sandbox: LivePage | null | undefined, sandboxed: boolean, live: boolean): boolean {
  if (sandbox !== undefined) return sandbox !== null;
  if (sandboxed) return false;
  return live || entry.kind === "live";
}

async function summarize(ws: Workspace, entry: RunEntry, state?: RunState, extras: SummaryExtras = {}): Promise<RunSummary> {
  const sandbox = await sandboxPageOf(entry.dir);
  const live = sandbox !== undefined ? sandbox !== null : (await localPage(entry.dir)) !== undefined;
  const s = entry.type === "run" ? (state ?? (await readState(entry.dir))) : undefined;
  const running = stillRunning(entry, sandbox, s?.sandbox !== undefined, live);
  const summary: RunSummary = {
    workspaceId: ws.id,
    type: entry.type,
    id: entry.id,
    // state.json keeps "running" when the process or its container was killed: it is interrupted, not running.
    status: entry.status === "running" && !running ? "interrupted" : entry.status,
    kind: entry.kind === "live" && !running ? "unfinished" : entry.kind,
    live,
    createdAt: entry.createdAt,
  };
  if (live) summary.viewUrl = viewUrlOf(ws.id, entry.id);
  if (sandbox !== undefined) summary.sandbox = { running: sandbox !== null };
  if (entry.type === "run") {
    if (s) {
      if (s.sandbox) summary.sandbox = { ...(summary.sandbox ?? { running: false, gone: true }), image: s.sandbox.image };
      summary.provider = s.provider;
      summary.taskCounts = countTasks(s);
    }
  } else {
    summary.provider = await readSuiteProvider(entry.dir);
  }
  const pr = extras.prs?.[`${ws.id}/${entry.id}`];
  if (pr) summary.pr = { url: pr.url, number: pr.number, forge: pr.forge };
  if (entry.status === "failed" || entry.status === "aborted") {
    const view = extras.dataDir ? await readCachedView(extras.dataDir, ws.id, entry.id) : undefined;
    const failure = failureOf(entry.status, view, s);
    if (failure !== undefined) summary.failure = failure;
  }
  return summary;
}

/** Newest first: by `createdAt`, then by id (ids start with a timestamp). */
export function newestFirst(a: RunSummary, b: RunSummary): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id);
}

/** The runs and suites of one workspace; none when it has no `.graph-execution` folder or the scan fails. */
export async function listWorkspaceRuns(ws: Workspace, prs?: PrIndex, dataDir?: string): Promise<RunSummary[]> {
  let entries: RunEntry[];
  try {
    entries = (await scan(ws.path)).runs;
  } catch {
    return [];
  }
  return Promise.all(entries.map((e) => summarize(ws, e, undefined, { prs, dataDir })));
}

/** Every run and suite of every workspace under `workspacesDir`, newest first. */
export async function listRuns(workspacesDir: string, prs?: PrIndex, dataDir?: string): Promise<RunSummary[]> {
  const workspaces = await listWorkspaces(workspacesDir);
  const all = await Promise.all(workspaces.map((ws) => listWorkspaceRuns(ws, prs, dataDir)));
  return all.flat().sort(newestFirst);
}

/** The first `# ` heading of a task's content, or undefined. */
export function taskTitle(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** Layers of a topological sort; dependencies on unknown ids are ignored, and nodes in a cycle land in a last layer. */
export function layersOf(ids: string[], deps: Map<string, string[]>): string[][] {
  const known = new Set(ids);
  const placed = new Set<string>();
  const layers: string[][] = [];
  let rest = [...ids];
  while (rest.length > 0) {
    const layer = rest.filter((id) => (deps.get(id) ?? []).every((d) => !known.has(d) || placed.has(d)));
    if (layer.length === 0) {
      layers.push(rest);
      break;
    }
    layers.push(layer);
    for (const id of layer) placed.add(id);
    rest = rest.filter((id) => !placed.has(id));
  }
  return layers;
}

const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

interface TaskFile {
  id: string;
  content: string;
  dependencies: string[];
}

/** Reads `<tasksDir>/*.json` task files (not `test-plan.json`); undefined when the folder is gone. */
async function readTasks(tasksDir: string): Promise<TaskFile[] | undefined> {
  let names: string[];
  try {
    names = (await readdir(tasksDir)).filter((n) => n.endsWith(".json") && n !== "test-plan.json");
  } catch {
    return undefined;
  }
  const tasks = await Promise.all(
    names.map(async (n) => {
      try {
        const raw = JSON.parse(await readFile(path.join(tasksDir, n), "utf8")) as Record<string, unknown>;
        const id = typeof raw.id === "string" ? raw.id : n.slice(0, -".json".length);
        const content = typeof raw.content === "string" ? raw.content : "";
        const dependencies = Array.isArray(raw.dependencies) ? raw.dependencies.filter((d): d is string => typeof d === "string") : [];
        return { id, content, dependencies };
      } catch {
        return undefined;
      }
    }),
  );
  return tasks.filter((t) => t !== undefined);
}

/** The graph of `state` from already-read task files, plus each task's known dependencies. */
function graphOf(state: RunState, tasks: TaskFile[] | undefined): { graph: RunGraph; deps: Map<string, string[]> } {
  const statusOf = (id: string): string => state.tasks[id]?.status ?? "pending";
  if (!tasks || tasks.length === 0) {
    const ids = Object.keys(state.tasks).sort(byId);
    return {
      graph: { nodes: ids.map((id) => ({ id, title: id, status: statusOf(id) })), edges: [], layers: ids.length ? [ids] : [] },
      deps: new Map(),
    };
  }
  return tasksGraph(tasks, statusOf);
}

/** The graph of task files (sorted by id, dependencies on unknown ids dropped), plus each task's known dependencies. */
function tasksGraph(tasks: TaskFile[], statusOf: (id: string) => string): { graph: RunGraph; deps: Map<string, string[]> } {
  const sorted = [...tasks].sort((a, b) => byId(a.id, b.id));
  const ids = sorted.map((t) => t.id);
  const known = new Set(ids);
  const deps = new Map(sorted.map((t) => [t.id, t.dependencies.filter((d) => known.has(d))]));
  const edges: [string, string][] = sorted.flatMap((t) => (deps.get(t.id) ?? []).map((d): [string, string] => [d, t.id]));
  return {
    graph: {
      nodes: sorted.map((t) => ({ id: t.id, title: taskTitle(t.content) ?? t.id, status: statusOf(t.id) })),
      edges,
      layers: layersOf(ids, deps),
    },
    deps,
  };
}

/** The static graph of a run: from its task files, or from `state.tasks` without edges when the folder is gone. */
export async function buildGraph(state: RunState): Promise<RunGraph> {
  return graphOf(state, await readTasks(state.tasksDir)).graph;
}

/** The graph of a task folder's files, every node `pending`; undefined when the folder can't be read. */
export async function folderGraph(tasksDir: string): Promise<RunGraph | undefined> {
  const tasks = await readTasks(tasksDir);
  return tasks ? tasksGraph(tasks, () => "pending").graph : undefined;
}

/** Pathspec of everything but graph-execution's own folder. */
const PATHSPEC = ["--", ".", `:(exclude)${RUNS_DIR}`];
const MAX_UNTRACKED_LINES = 10_000;

async function git(ws: Workspace, args: string[]): Promise<string | undefined> {
  try {
    const res = await execa("git", args, {
      cwd: ws.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      reject: false,
      stdin: "ignore",
      timeout: 10_000,
    });
    return res.exitCode === 0 ? String(res.stdout ?? "") : undefined;
  } catch {
    return undefined;
  }
}

/** Sums `git diff --numstat` output; binary files (`-`) count as 0. */
export function sumNumstat(out: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of out.split("\n")) {
    const [a, d] = line.split("\t");
    if (a === undefined || d === undefined) continue;
    if (/^\d+$/.test(a)) added += Number(a);
    if (/^\d+$/.test(d)) deleted += Number(d);
  }
  return { added, deleted };
}

/** Lines of a text file, capped; 0 for a binary (a NUL byte in its first 8 KiB) or unreadable file. */
async function countLines(file: string): Promise<number> {
  try {
    const fh = await open(file, "r");
    try {
      const head = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      if (head.subarray(0, bytesRead).includes(0)) return 0;
    } finally {
      await fh.close();
    }
    const text = await readFile(file, "utf8");
    if (text === "") return 0;
    let n = 0;
    for (let i = text.indexOf("\n"); i !== -1 && n < MAX_UNTRACKED_LINES; i = text.indexOf("\n", i + 1)) n++;
    if (!text.endsWith("\n") && n < MAX_UNTRACKED_LINES) n++;
    return n;
  } catch {
    return 0;
  }
}

/** The uncommitted changes in the workspace, outside `.graph-execution`; undefined when git fails. */
export async function landedChanges(ws: Workspace): Promise<Landed | undefined> {
  const status = await git(ws, ["status", "--porcelain", "--untracked-files=all", ...PATHSPEC]);
  if (status === undefined) return undefined;
  const files = status.split("\n").filter((l) => l.trim() !== "").length;
  const numstat = (await git(ws, ["diff", "--numstat", "HEAD", ...PATHSPEC])) ?? "";
  const { added, deleted } = sumNumstat(numstat);
  const untracked = ((await git(ws, ["ls-files", "--others", "--exclude-standard", "-z", ...PATHSPEC])) ?? "").split("\0").filter((f) => f !== "");
  const extra = await Promise.all(untracked.map((f) => countLines(path.join(ws.path, f))));
  return { files, added: added + extra.reduce((a, b) => a + b, 0), deleted };
}

/** Lines a merged task added and deleted, from its commits; undefined when they are missing or gone. */
async function taskLines(ws: Workspace, base: string | undefined, merge: string | undefined): Promise<{ added: number; deleted: number } | undefined> {
  if (!base || !merge) return undefined;
  const out = await git(ws, ["diff", "--numstat", base, merge, ...PATHSPEC]);
  return out === undefined ? undefined : sumNumstat(out);
}

/** The task table: state (status, attempts) + cached view (times, lines, error) + task files (title, deps), by layer then id. */
async function taskRows(ws: Workspace, state: RunState, graph: RunGraph, deps: Map<string, string[]>, view: CachedView | undefined): Promise<TaskRow[]> {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const order = graph.layers.flat();
  return Promise.all(
    order.map(async (id) => {
      const st = state.tasks[id];
      const cached = view?.nodes[id];
      const row: TaskRow = {
        id,
        title: nodes.get(id)?.title ?? id,
        status: st?.status ?? cached?.status ?? "pending",
        attempts: st?.attempts ?? cached?.attempts ?? 0,
        deps: deps.get(id) ?? [],
      };
      if (cached?.startedAt !== undefined) row.startedAt = cached.startedAt;
      if (cached?.endedAt !== undefined) row.endedAt = cached.endedAt;
      if (cached?.error !== undefined) row.error = cached.error;
      if (cached?.added !== undefined && cached.deleted !== undefined) {
        row.added = cached.added;
        row.deleted = cached.deleted;
      } else if (st?.status === "merged") {
        const lines = await taskLines(ws, st.baseSha, st.mergeCommit);
        if (lines) Object.assign(row, lines);
      }
      return row;
    }),
  );
}

/**
 * One run or suite of a workspace with its state, static graph, task table and (when applied) landed changes;
 * undefined when there is none with this id. With `dataDir`, also the cached view of the run page.
 */
export async function runDetail(ws: Workspace, runId: string, dataDir?: string): Promise<RunDetail | undefined> {
  if (!isRunId(runId)) return undefined;
  let entries: RunEntry[];
  try {
    entries = (await scan(ws.path)).runs;
  } catch {
    return undefined;
  }
  const entry = entries.find((e) => e.id === runId);
  if (!entry) return undefined;
  if (entry.type === "suite") return { summary: await summarize(ws, entry) };
  const state = await readState(entry.dir);
  const summary = await summarize(ws, entry, state);
  if (!state) return { summary };
  const [files, view] = await Promise.all([readTasks(state.tasksDir), dataDir ? readCachedView(dataDir, ws.id, runId) : Promise.resolve(undefined)]);
  const { graph, deps } = graphOf(state, files);
  const detail: RunDetail = { summary, state, graph };
  if (view) detail.view = view;
  detail.tasks = await taskRows(ws, state, graph, deps, view);
  if (summary.kind !== "live" && summary.status !== "running") {
    // state.json keeps "running" for a task the run was stopped in; show it as interrupted once the run has ended.
    const settle = (s: string) => (IN_FLIGHT.has(s) ? "interrupted" : s);
    for (const n of graph.nodes) n.status = settle(n.status);
    for (const t of detail.tasks) t.status = settle(t.status);
  }
  if (state.status === "applied") {
    const landed = await landedChanges(ws);
    if (landed) detail.landed = landed;
  }
  return detail;
}

/** `<workspace>/.graph-execution/<runId>`, the folder of a run or suite. */
export const runDirOf = (ws: Workspace, runId: string): string => path.join(ws.path, RUNS_DIR, runId);
