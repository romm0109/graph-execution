import { readFile } from "node:fs/promises";
import { loadTasks } from "../graph/load.js";
import type { PlanView } from "../runner/events.js";
import { SANDBOX_ENV } from "../state/paths.js";
import type { RunState } from "../state/state.js";
import { planSpecRel, planTasksRel, runInputs } from "./paths.js";

/** The planned spec's text is cut at this many characters on the run page. */
export const PLAN_SPEC_MAX_CHARS = 200_000;

const STATUSES = new Set<PlanView["status"]>(["planning", "needs-info", "awaiting-approval", "running", "failed", "aborted"]);

/** A task's title on the run page: the first `# ` heading of its content, else its id. */
export function taskTitle(task: { id: string; content: string }): string {
  const heading = task.content.split("\n").find((l) => /^# \S/.test(l));
  return heading ? heading.slice(2).trim() : task.id;
}

/**
 * The run page's view of a planned run's plan stage, from its state: the status (any status after the plan stage
 * counts as `running`), the planner rounds, refs, questions and dropped refs and, once the plan is committed, its spec
 * text and task list (read from the integration worktree, so the page keeps them after the process exits) and the
 * approve / replan commands.
 */
export async function planView(
  state: RunState,
  runDir: string,
  extra: { attempts: number; lastError?: string },
): Promise<PlanView> {
  const plan = state.plan;
  const status = STATUSES.has(state.status as PlanView["status"]) ? (state.status as PlanView["status"]) : "running";
  const view: PlanView = {
    status,
    attempt: plan?.attempts ?? 0,
    attempts: extra.attempts,
    refs: (plan?.refs ?? []).map((r) => ({ ...r })),
    ...(extra.lastError !== undefined ? { lastError: extra.lastError } : {}),
    ...(plan?.error !== undefined ? { error: plan.error } : {}),
    questions: (plan?.questions ?? []).map((q) => ({ ...q, questions: [...q.questions] })),
    dropped: [...(plan?.dropped ?? [])],
    branch: state.integrationBranch,
  };
  const name = plan?.name;
  if (name === undefined) return view;
  view.name = name;
  view.specRel = planSpecRel(name);
  view.tasksRel = planTasksRel(name);
  const { specPath, tasksDir } = runInputs(state, runDir);
  try {
    const text = await readFile(specPath, "utf8");
    view.spec = text.length > PLAN_SPEC_MAX_CHARS ? `${text.slice(0, PLAN_SPEC_MAX_CHARS)}\n\n… (cut)` : text;
  } catch {
    // The page shows the plan without its spec.
  }
  try {
    view.tasks = (await loadTasks(tasksDir)).map((t) => ({ id: t.id, title: taskTitle(t), dependencies: [...t.dependencies] }));
  } catch {
    // The page shows the plan without its task list.
  }
  if (status === "awaiting-approval") {
    const sandbox = process.env[SANDBOX_ENV] === "1" ? " --sandbox" : "";
    const resume = `graph-execution --resume --run ${state.runId}`;
    view.approve = `${resume} --approve-plan${sandbox}`;
    view.replan = `${resume} --replan <feedback.md>${sandbox}`;
    if (sandbox) view.hint = "or approve it in graph-manager";
  }
  return view;
}
