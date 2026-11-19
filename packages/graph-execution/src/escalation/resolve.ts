import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { renameReplacing } from "../fs/rename.js";
import { GraphError } from "../graph/errors.js";
import { loadTasks } from "../graph/load.js";
import { type Task, taskSchema } from "../graph/task.js";
import { TEST_PLAN_FILE } from "../graph/testPlan.js";
import { byId, validateGraph } from "../graph/validate.js";
import type { GraphUpdate } from "../scheduler/scheduler.js";
import { acquireLock, StateStore, type TaskState } from "../state/state.js";
import type { EscalationRecord } from "./schema.js";
import { loadEscalations, saveEscalation } from "./store.js";
import { runInputs } from "../plan/paths.js";

/** How a paused branch is resolved (docs/prd/escalation.md, "Resolution"). */
export const resolutionSchema = z.object({
  escalationIds: z.array(z.string().regex(/^E\d+$/)).min(1),
  action: z.enum(["continue", "change", "abort"]),
  guidance: z.string().optional(),
  answers: z
    .array(z.object({ escalationId: z.string(), questionId: z.string(), answer: z.string().min(1) }))
    .optional(),
  editTasks: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1).optional(),
        dependencies: z.array(z.string()).optional(),
        validate: taskSchema.shape.validate,
      }),
    )
    .optional(),
  addTasks: z.array(taskSchema).optional(),
  removeTasks: z.array(z.string()).optional(),
  reopen: z.array(z.string()).optional(),
});
export type Resolution = z.infer<typeof resolutionSchema>;

/** A refused resolution: `status` is the HTTP status, `code` the machine-readable reason. */
export class ResolutionError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

export interface ResolutionInput {
  /** The effective task set now. */
  tasks: Task[];
  states: Record<string, TaskState>;
  escalations: EscalationRecord[];
  /** Every task id this run ever had, removed ones included: an added task may not reuse one. */
  usedIds: string[];
}

export interface CheckedResolution {
  resolution: Resolution;
  /** The new task set (the same array when the resolution does not change it). */
  tasks: Task[];
  /** Tasks to run again: the escalated tasks that were not removed, then the reopened ones. */
  requeue: string[];
  removed: string[];
  /** True when tasks were edited, added or removed. */
  changed: boolean;
}

const nonEmpty = <T>(list: T[] | undefined): list is T[] => list !== undefined && list.length > 0;

/** Checks `raw` against the task set and escalations at this moment; throws `ResolutionError` when it is refused. */
export function checkResolution(input: ResolutionInput, raw: unknown): CheckedResolution {
  const parsed = resolutionSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
    throw new ResolutionError(400, "invalid", message);
  }
  const resolution = parsed.data;
  const edits = resolution.editTasks ?? [];
  const adds = resolution.addTasks ?? [];
  const removes = [...new Set(resolution.removeTasks ?? [])];
  const reopen = [...new Set(resolution.reopen ?? [])];
  if (resolution.action !== "change" && (nonEmpty(edits) || nonEmpty(adds) || nonEmpty(removes) || nonEmpty(reopen))) {
    throw new ResolutionError(400, "invalid", `"${resolution.action}" takes no task changes`);
  }

  const ids = [...new Set(resolution.escalationIds)];
  const resolved: EscalationRecord[] = [];
  for (const id of ids) {
    const record = input.escalations.find((e) => e.id === id);
    if (record?.status !== "open") throw new ResolutionError(409, "not_open", `escalation ${id} is not open`);
    resolved.push(record);
  }
  for (const a of resolution.answers ?? []) {
    const record = resolved.find((e) => e.id === a.escalationId);
    if (!record) throw new ResolutionError(400, "invalid", `answer for ${a.escalationId}, which this resolution does not resolve`);
    if (!record.questions.some((q) => q.id === a.questionId)) {
      throw new ResolutionError(400, "invalid", `escalation ${a.escalationId} has no question ${a.questionId}`);
    }
  }

  const byTask = new Map(input.tasks.map((t) => [t.id, t]));
  const status = (id: string): string => input.states[id]?.status ?? "pending";
  for (const id of [...edits.map((e) => e.id), ...removes]) {
    if (!byTask.has(id)) throw new ResolutionError(400, "invalid", `unknown task ${id}`);
  }
  for (const id of reopen) if (!byTask.has(id)) throw new ResolutionError(400, "invalid", `unknown task ${id}`);
  for (const id of [...edits.map((e) => e.id), ...removes]) {
    const s = status(id);
    if (s !== "pending" && s !== "escalated") throw new ResolutionError(409, "task_started", `task ${id} has started (${s})`);
  }
  for (const id of reopen) {
    const s = status(id);
    if (s !== "merged") throw new ResolutionError(409, "not_merged", `task ${id} is not merged (${s})`);
  }
  // Removing the task of another open escalation would leave that escalation pointing nowhere.
  for (const id of removes) {
    const other = input.escalations.find((e) => e.status === "open" && e.node === id && !ids.includes(e.id));
    if (other) throw new ResolutionError(400, "invalid", `task ${id} waits on ${other.id}; resolve it in this resolution`);
  }
  const used = new Set([...input.usedIds, ...byTask.keys()]);
  const added = new Set<string>();
  for (const t of adds) {
    if (used.has(t.id) || added.has(t.id)) throw new ResolutionError(400, "duplicate_id", `task id ${t.id} is already used in this run`);
    added.add(t.id);
  }

  const changed = edits.length > 0 || adds.length > 0 || removes.length > 0;
  let tasks = input.tasks;
  if (changed) {
    const editById = new Map(edits.map((e) => [e.id, e]));
    const removed = new Set(removes);
    tasks = [
      ...input.tasks
        .filter((t) => !removed.has(t.id))
        .map((t) => {
          const e = editById.get(t.id);
          if (!e) return t;
          const next: Task = { ...t };
          if (e.content !== undefined) next.content = e.content;
          if (e.dependencies !== undefined) next.dependencies = [...e.dependencies];
          if (e.validate !== undefined) next.validate = e.validate;
          return next;
        }),
      ...adds,
    ];
    const problems = tasks.flatMap((t) =>
      t.dependencies.filter((d) => removed.has(d)).map((d) => `task "${t.id}" depends on removed task "${d}"`),
    );
    if (problems.length > 0) throw new ResolutionError(400, "graph", problems.join("; "));
    try {
      validateGraph(tasks);
    } catch (err) {
      if (err instanceof GraphError) throw new ResolutionError(400, "graph", err.problems.join("; "));
      throw err;
    }
  }

  const keep = new Set(tasks.map((t) => t.id));
  const requeue = [
    ...new Set([...resolved.map((e) => e.node).filter((id) => keep.has(id)), ...reopen]),
  ];
  return { resolution, tasks, requeue, removed: removes, changed };
}

/** `<runDir>/tasks`: the run's own copy of the task set once a resolution changed it. */
export const runTasksDir = (runDir: string): string => path.join(runDir, "tasks");

/** Every task id the run ever had: the state's and the ones earlier resolutions removed. */
export function usedTaskIds(states: Record<string, TaskState>, escalations: EscalationRecord[]): string[] {
  const removed = escalations.flatMap((e) => {
    const r = resolutionSchema.safeParse(e.resolution);
    return r.success ? (r.data.removeTasks ?? []) : [];
  });
  return [...new Set([...Object.keys(states), ...removed])];
}

/** Writes the effective task set to `<runDir>/tasks/<id>.json` (atomically) and drops files of removed tasks. */
async function writeRunTasks(runDir: string, tasks: Task[], tasksDir: string): Promise<void> {
  const dir = runTasksDir(runDir);
  await mkdir(dir, { recursive: true });
  const keep = new Set(tasks.map((t) => `${t.id}.json`));
  for (const task of tasks) {
    const file = path.join(dir, `${task.id}.json`);
    await writeFile(`${file}.tmp`, `${JSON.stringify(task, null, 2)}\n`);
    await renameReplacing(`${file}.tmp`, file);
  }
  for (const name of await readdir(dir)) {
    if (name.endsWith(".json") && name !== TEST_PLAN_FILE && !keep.has(name)) await rm(path.join(dir, name), { force: true });
  }
  // The test plan is not a task: it stays the user's, copied so the run's folder is complete.
  const plan = path.join(tasksDir, TEST_PLAN_FILE);
  if (existsSync(plan)) await copyFile(plan, path.join(dir, TEST_PLAN_FILE));
}

/**
 * Checks and applies a resolution to the run's state: writes the run's task copy when the task set changed, resets
 * the requeued tasks to a fresh `pending`, adds and drops state entries, and marks the escalations resolved. For
 * `abort` it marks them resolved and the run `aborted` for good (`abortedBy`); a live caller also ends its process. Throws `ResolutionError` when refused.
 */
export async function applyResolution(
  runDir: string,
  store: StateStore,
  tasks: Task[],
  raw: unknown,
): Promise<{ resolution: Resolution; update: GraphUpdate; changed: boolean }> {
  const escalations = await loadEscalations(runDir);
  const checked = checkResolution(
    { tasks, states: store.state.tasks, escalations, usedIds: usedTaskIds(store.state.tasks, escalations) },
    raw,
  );
  const { resolution } = checked;
  const abort = resolution.action === "abort";
  if (!abort && checked.changed) await writeRunTasks(runDir, checked.tasks, runInputs(store.state, runDir).tasksDir);
  const resolvedAt = new Date().toISOString();
  const ids = new Set(resolution.escalationIds);
  for (const record of escalations) {
    if (ids.has(record.id)) await saveEscalation(runDir, { ...record, status: "resolved", resolvedAt, resolution });
  }
  const reopened = new Set(resolution.reopen ?? []);
  await store.update((s) => {
    for (const e of s.escalations) if (ids.has(e.id)) e.status = "resolved";
    if (abort) {
      // The run ends as `aborted` and stays so: `--resume` refuses it (live, the run process also ends itself).
      s.status = "aborted";
      s.abortedBy = "resolution";
      return;
    }
    if (checked.changed) s.tasksSource = "run";
    for (const id of checked.removed) delete s.tasks[id];
    for (const t of resolution.addTasks ?? []) s.tasks[t.id] = { status: "pending", attempts: 0 };
    for (const id of checked.requeue) {
      const prev = s.tasks[id];
      s.tasks[id] = {
        status: "pending",
        attempts: 0,
        ...(reopened.has(id) && prev?.branch ? { branch: prev.branch } : {}),
        ...(reopened.has(id) && prev?.mergeCommit ? { mergeCommit: prev.mergeCommit } : {}),
      };
    }
  });
  const update: GraphUpdate = abort
    ? { tasks, requeue: [], removed: [] }
    : { tasks: checked.tasks, requeue: checked.requeue, removed: checked.removed };
  return { resolution, update, changed: !abort && checked.changed };
}

/**
 * Applies a resolution to a run that is not live (stopped with Ctrl+C), under the run lock; `--resume` continues
 * from it. Throws `ResolutionError` when refused, `LockError` when the run is live.
 */
export async function applyResolutionOffline(
  runDir: string,
  raw: unknown,
): Promise<{ resolution: Resolution; requeued: string[] }> {
  const release = await acquireLock(runDir);
  try {
    const store = await StateStore.load(path.join(runDir, "state.json"));
    const tasks = await loadTasks(store.state.tasksSource === "run" ? runTasksDir(runDir) : runInputs(store.state, runDir).tasksDir);
    const { resolution, update } = await applyResolution(runDir, store, tasks, raw);
    return { resolution, requeued: update.requeue };
  } finally {
    await release();
  }
}

/** The `## Decision` section of a rerun or reopened task's prompt. */
export function decisionSection(input: { escalations: EscalationRecord[]; resolution: Resolution; reopened: boolean }): string[] {
  const out = ["## Decision", ""];
  if (input.escalations.length > 0) {
    out.push("This task's branch of the run was paused for a decision, which has now been made.", "");
  }
  for (const e of [...input.escalations].sort((a, b) => byId(a.id, b.id))) {
    out.push(`Escalation ${e.id} (task ${e.node}): ${e.reason}`, "");
    for (const q of e.questions) {
      const answer = input.resolution.answers?.find((a) => a.escalationId === e.id && a.questionId === q.id);
      out.push(`- ${q.id}: ${q.question}`);
      if (answer) out.push(`  Answer: ${answer.answer}`);
    }
    out.push("");
  }
  if (input.resolution.guidance?.trim()) out.push("Guidance:", "", input.resolution.guidance.trim(), "");
  if (input.reopened) {
    out.push("Your earlier work for this task is already merged into this checkout. Change it as the decision requires.", "");
  }
  return out;
}
