import { readdir, readFile } from "node:fs/promises";
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

export interface RunDetail {
  summary: RunSummary;
  state?: RunState;
  graph?: RunGraph;
}

export const isRunId = (id: string): boolean => RUN_ID_PATTERN.test(id);

export const viewUrlOf = (workspaceId: string, runId: string): string =>
  `/runs/${encodeURIComponent(workspaceId)}/${encodeURIComponent(runId)}/view/`;

/** The run's page URL from `web.json`, when the process that wrote it is alive. */
export async function livePage(runDir: string): Promise<{ url: string; pid: number } | undefined> {
  const web = await readWebJson(runDir);
  return web && isAlive(web.pid) ? web : undefined;
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

async function summarize(ws: Workspace, entry: RunEntry, state?: RunState): Promise<RunSummary> {
  const live = (await livePage(entry.dir)) !== undefined;
  const summary: RunSummary = {
    workspaceId: ws.id,
    type: entry.type,
    id: entry.id,
    status: entry.status,
    kind: entry.kind,
    live,
    createdAt: entry.createdAt,
  };
  if (live) summary.viewUrl = viewUrlOf(ws.id, entry.id);
  if (entry.type === "run") {
    const s = state ?? (await readState(entry.dir));
    if (s) {
      summary.provider = s.provider;
      summary.taskCounts = countTasks(s);
    }
  } else {
    summary.provider = await readSuiteProvider(entry.dir);
  }
  return summary;
}

/** Newest first: by `createdAt`, then by id (ids start with a timestamp). */
function newestFirst(a: RunSummary, b: RunSummary): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id);
}

/** The runs and suites of one workspace; none when it has no `.graph-execution` folder or the scan fails. */
export async function listWorkspaceRuns(ws: Workspace): Promise<RunSummary[]> {
  let entries: RunEntry[];
  try {
    entries = (await scan(ws.path)).runs;
  } catch {
    return [];
  }
  return Promise.all(entries.map((e) => summarize(ws, e)));
}

/** Every run and suite of every workspace under `workspacesDir`, newest first. */
export async function listRuns(workspacesDir: string): Promise<RunSummary[]> {
  const workspaces = await listWorkspaces(workspacesDir);
  const all = await Promise.all(workspaces.map((ws) => listWorkspaceRuns(ws)));
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

/** Reads `<tasksDir>/*.json` task files (not `test-plan.json`); undefined when the folder is gone. */
async function readTasks(tasksDir: string): Promise<{ id: string; content: string; dependencies: string[] }[] | undefined> {
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

/** The static graph of a run: from its task files, or from `state.tasks` without edges when the folder is gone. */
export async function buildGraph(state: RunState): Promise<RunGraph> {
  const tasks = await readTasks(state.tasksDir);
  const statusOf = (id: string): string => state.tasks[id]?.status ?? "pending";
  if (!tasks || tasks.length === 0) {
    const ids = Object.keys(state.tasks).sort(byId);
    return { nodes: ids.map((id) => ({ id, title: id, status: statusOf(id) })), edges: [], layers: ids.length ? [ids] : [] };
  }
  tasks.sort((a, b) => byId(a.id, b.id));
  const ids = tasks.map((t) => t.id);
  const known = new Set(ids);
  const deps = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const edges: [string, string][] = tasks.flatMap((t) => t.dependencies.filter((d) => known.has(d)).map((d): [string, string] => [d, t.id]));
  return {
    nodes: tasks.map((t) => ({ id: t.id, title: taskTitle(t.content) ?? t.id, status: statusOf(t.id) })),
    edges,
    layers: layersOf(ids, deps),
  };
}

/** One run or suite of a workspace with its state and static graph; undefined when there is none with this id. */
export async function runDetail(ws: Workspace, runId: string): Promise<RunDetail | undefined> {
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
  return { summary, state, graph: await buildGraph(state) };
}

/** `<workspace>/.graph-execution/<runId>`, the folder of a run or suite. */
export const runDirOf = (ws: Workspace, runId: string): string => path.join(ws.path, RUNS_DIR, runId);
