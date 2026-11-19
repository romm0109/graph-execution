import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { commitPaths, currentHead } from "../git/git.js";
import { GraphError } from "../graph/errors.js";
import { loadTasks } from "../graph/load.js";
import type { Task } from "../graph/task.js";
import { loadTestPlan } from "../graph/testPlan.js";
import { validateGraph } from "../graph/validate.js";
import { checkSpec, UsageError } from "../launch/preflight.js";
import type { Provider } from "../providers/types.js";
import type { PlanRef } from "../state/state.js";
import { planContentPath, planRefsPath, planResultPath, planSpecRel, planTasksRel } from "./paths.js";
import { plannerPrompt, validateTasksScript } from "./prompt.js";
import { readPlanResult } from "./result.js";

export interface PlanStageInput {
  repo: string;
  runDir: string;
  /** The integration worktree, clean at its HEAD; the planner runs in it. */
  worktree: string;
  provider: Provider;
  model?: string;
  signal: AbortSignal;
  log: (line: string) => void;
  /** The run's refs; empty: the content is one unit. */
  refs: PlanRef[];
  /** Why the engine rejected the previous round; the planner gets it in its prompt. */
  previousError?: string;
  /** Feedback texts of rejected plans, oldest first; the planner gets them in its prompt. */
  feedback: string[];
  /** The last rejected plan's commit, named in the prompt. */
  rejectedCommit?: string;
}

type Questions = { ref?: string; questions: string[] }[];

export type PlanStageResult =
  | { ok: true; kind: "planned"; name: string; commit: string; tasks: Task[]; dropped: string[]; questions: Questions }
  | { ok: true; kind: "needs-info"; dropped: string[]; questions: Questions }
  | { ok: false; error: string };

/** Entries `{ type, name }` of the folder `dir` (git path) in commit `base`; none when the folder is missing. */
async function treeEntries(cwd: string, base: string, dir: string): Promise<{ type: string; name: string }[]> {
  const res = await execa("git", ["ls-tree", base, "--", `${dir}/`], { cwd, reject: false });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", rel = ""] = line.split("\t");
      return { type: meta.split(" ")[1] ?? "", name: path.posix.basename(rel) };
    });
}

/**
 * Plan names in use in commit `base` of `worktree`: specs in `docs/prd/` and `docs/prd/done/`, and task folders in
 * `.agents/tasks/`. Read from git, not the working directory, so a retried planner's own files never count.
 */
export async function takenPlanNames(worktree: string, base?: string): Promise<string[]> {
  const commit = base ?? (await currentHead(worktree));
  const specs = async (dir: string): Promise<string[]> =>
    (await treeEntries(worktree, commit, dir)).filter((e) => e.type === "blob" && e.name.endsWith(".md")).map((e) => e.name.slice(0, -3));
  const names = [
    ...(await specs("docs/prd")),
    ...(await specs("docs/prd/done")),
    ...(await treeEntries(worktree, commit, ".agents/tasks")).filter((e) => e.type === "tree").map((e) => e.name),
  ];
  return [...new Set(names)].sort();
}

const existsAt = async (cwd: string, base: string, rel: string): Promise<boolean> =>
  (await execa("git", ["cat-file", "-e", `${base}:${rel}`], { cwd, reject: false })).exitCode === 0;

/**
 * One planner round: runs the planner in the integration worktree, reads its readiness, and when something is ready
 * checks what it wrote and commits it as `Plan: <name>`. Nothing ready: `needs-info`, no file is checked or committed.
 */
export async function planStage(input: PlanStageInput): Promise<PlanStageResult> {
  const { worktree, runDir, signal, log } = input;
  const base = await currentHead(worktree);
  const taken = await takenPlanNames(worktree, base);
  const resultPath = planResultPath(runDir);
  await rm(resultPath, { force: true });
  const contentPath = planContentPath(runDir);
  const content = await readFile(contentPath, "utf8");
  const prompt = await plannerPrompt({
    content,
    contentPath,
    resultPath,
    taken,
    validateScript: validateTasksScript(),
    refs: input.refs,
    ...(input.refs.length > 0 ? { refsPath: planRefsPath(runDir) } : {}),
    ...(input.previousError !== undefined ? { previousError: input.previousError } : {}),
    feedback: input.feedback,
    ...(input.rejectedCommit !== undefined ? { rejectedCommit: input.rejectedCommit } : {}),
  });

  try {
    const agent = input.provider.run({ role: "planner", label: "plan", prompt, cwd: worktree, signal, model: input.model });
    const forward = async (): Promise<void> => {
      for await (const event of agent.events) {
        if (event.type === "output") log(`[plan] ${event.text.trimEnd()}`);
      }
    };
    const [, { exitCode }] = await Promise.all([forward(), agent.done]);
    if (signal.aborted) throw signal.reason ?? new Error("planning was interrupted");
    if (exitCode !== 0) return { ok: false, error: `the planner exited with code ${exitCode}` };
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const read = await readPlanResult(resultPath, input.refs);
  if (!read.ok) return read;
  const { dropped, questions } = read.readiness;
  if (read.readiness.nothingReady) return { ok: true, kind: "needs-info", dropped, questions };
  const name = read.readiness.name!;
  const occupied = [planSpecRel(name), `docs/prd/done/${name}.md`, planTasksRel(name)];
  if (taken.includes(name) || (await Promise.all(occupied.map((rel) => existsAt(worktree, base, rel)))).some(Boolean)) {
    return { ok: false, error: `name ${name} is taken: use ${name}-2` };
  }
  const specPath = path.join(worktree, ...planSpecRel(name).split("/"));
  const tasksDir = path.join(worktree, ...planTasksRel(name).split("/"));
  let tasks: Task[];
  try {
    await checkSpec(specPath);
    tasks = await loadTasks(tasksDir);
    validateGraph(tasks);
    await loadTestPlan(tasksDir);
  } catch (err) {
    if (err instanceof UsageError || err instanceof GraphError) return { ok: false, error: err.message };
    throw err;
  }
  const commit = await commitPaths(worktree, base, [planSpecRel(name), planTasksRel(name)], `Plan: ${name}`);
  return { ok: true, kind: "planned", name, commit, tasks, dropped, questions };
}
