import { existsSync, type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { runInputs } from "../plan/paths.js";
import { type RunState, stateSchema } from "../state/state.js";
import { checkResolution, type Resolution, ResolutionError, resolutionSchema, runTasksDir, usedTaskIds } from "./resolve.js";
import { escalationsDir, loadEscalations } from "./store.js";

/** `<runDir>/escalations/<id>/draft.json`: a proposed resolution (written by the advisor, by hand or by a test). */
export const draftPath = (runDir: string, id: string): string => path.join(escalationsDir(runDir), id, "draft.json");

/** The run's task states from `state.json`; `undefined` when there is none (yet). */
async function readStates(runDir: string): Promise<RunState | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(runDir, "state.json"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = stateSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** The run's effective task set from disk: the run's own copy once a resolution changed it, else the task folder. */
export async function currentTasks(runDir: string): Promise<Task[]> {
  const state = await readStates(runDir);
  if (!state) return [];
  return loadTasks(state.tasksSource === "run" ? runTasksDir(runDir) : runInputs(state, runDir).tasksDir);
}

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");

/**
 * Reads escalation `id`'s draft. A missing file is `{ draft: null }`; invalid JSON or schema is `{ draft: null, error }`.
 * A draft that passes the schema is also checked against the run's current state and tasks: a refusal is `error` next
 * to the draft (a preview only; the run checks again when it is applied).
 */
export async function readDraft(
  runDir: string,
  id: string,
  opts: { tasks?: Task[] } = {},
): Promise<{ draft: Resolution | null; error?: string }> {
  let text: string;
  try {
    text = await readFile(draftPath(runDir, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { draft: null };
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { draft: null, error: `draft.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = resolutionSchema.safeParse(data);
  if (!parsed.success) return { draft: null, error: `draft.json: ${issues(parsed.error)}` };
  const draft = parsed.data;
  try {
    const state = await readStates(runDir);
    if (state) {
      const escalations = await loadEscalations(runDir);
      const tasks = opts.tasks ?? (await loadTasks(state.tasksSource === "run" ? runTasksDir(runDir) : runInputs(state, runDir).tasksDir));
      checkResolution({ tasks, states: state.tasks, escalations, usedIds: usedTaskIds(state.tasks, escalations) }, draft);
    }
  } catch (err) {
    if (err instanceof ResolutionError) return { draft, error: `refused (${err.code}): ${err.message}` };
    // The preview is best effort: a task folder that cannot be read now is the run's problem, not the draft's.
  }
  return { draft };
}

const DEBOUNCE_MS = 200;
const POLL_MS = 1000;
const ID = /^E\d+$/;

/**
 * Calls `onChange(id)` when `<runDir>/escalations/<id>/draft.json` appears, changes or goes away. Uses a recursive
 * `fs.watch` where the platform has one, else one watcher on the folder plus one per escalation folder; events are
 * debounced 200 ms per id. A poll every second catches what a watcher misses, and is all there is when `fs.watch`
 * throws. The escalations folder is never created: a run without escalations has none, and the watch starts once it
 * appears. Returns a function that stops watching.
 */
export function watchDrafts(runDir: string, onChange: (id: string) => void): () => void {
  const dir = escalationsDir(runDir);
  let stopped = false;
  /** The last seen `mtime:size` of each draft ("" = none). */
  const seen = new Map<string, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const watchers = new Map<string, FSWatcher>();

  const signature = async (id: string): Promise<string> => {
    try {
      const s = await stat(draftPath(runDir, id));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "";
    }
  };
  /** `force`: a watcher saw a write, which counts even when mtime and size look the same. */
  const check = async (id: string, force: boolean): Promise<void> => {
    const sig = await signature(id);
    if (stopped) return;
    const before = seen.get(id);
    seen.set(id, sig);
    if (before === undefined ? sig !== "" : force || before !== sig) onChange(id);
  };
  const touched = (id: string): void => {
    if (stopped || !ID.test(id)) return;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void check(id, true);
      }, DEBOUNCE_MS),
    );
  };
  const onEvent = (filename: string | Buffer | null): void => {
    if (filename === null) return;
    const parts = filename.toString().split(/[\\/]/);
    if (parts.length === 1) {
      // An escalation folder appeared (or the top folder changed): follow it, and look for a draft in it.
      if (!recursive) watchFolder(parts[0]!);
      touched(parts[0]!);
    } else if (parts[1]!.startsWith("draft.json")) touched(parts[0]!);
  };
  const watchFolder = (id: string): void => {
    if (stopped || !ID.test(id) || watchers.has(id)) return;
    try {
      const w = watch(path.join(dir, id), (_e, name) => {
        if (name !== null && name.toString().startsWith("draft.json")) touched(id);
      });
      w.on("error", () => undefined);
      watchers.set(id, w);
    } catch {
      // Not a folder (an `E<n>.json` record) or gone: the poll covers it.
    }
  };

  let recursive = true;
  let top: FSWatcher | undefined;
  /** Watching started, or is starting. The folder is not created here: until it exists, the poll looks for it. */
  let watching = false;
  const startWatch = async (): Promise<void> => {
    if (stopped || watching || !existsSync(dir)) return;
    watching = true;
    try {
      top = watch(dir, { recursive: true }, (_e, name) => onEvent(name));
    } catch {
      recursive = false;
      try {
        top = watch(dir, (_e, name) => onEvent(name));
      } catch {
        return; // polling only
      }
    }
    top.on("error", () => undefined);
    if (!recursive) for (const name of await readdir(dir).catch(() => [])) watchFolder(name);
  };

  const poll = async (): Promise<void> => {
    if (!watching) await startWatch();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      names = [];
    }
    const ids = new Set([...names.filter((n) => ID.test(n)), ...seen.keys()]);
    for (const id of ids) {
      if (!recursive && names.includes(id)) watchFolder(id);
      if (!timers.has(id)) await check(id, false);
    }
  };
  // The first poll records the drafts already there without reporting them.
  const initial = (async () => {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      /* none yet */
    }
    for (const id of names.filter((n) => ID.test(n))) seen.set(id, await signature(id));
  })();
  void initial.then(startWatch);
  const interval = setInterval(() => void initial.then(poll), POLL_MS);
  interval.unref();

  return () => {
    stopped = true;
    clearInterval(interval);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    top?.close();
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}
