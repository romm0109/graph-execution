import path from "node:path";
import type { RunState } from "../state/state.js";

/** The plan stage's folder inside a run directory. */
export const PLAN_DIR = "plan";
/** `<runDir>/plan` */
export const planDir = (runDir: string): string => path.join(runDir, PLAN_DIR);
/** `<runDir>/plan/result.json`: the planner's result file. */
export const planResultPath = (runDir: string): string => path.join(planDir(runDir), "result.json");
/** `<runDir>/plan/content.md`: the run's copy of the `--content` file. */
export const planContentPath = (runDir: string): string => path.join(planDir(runDir), "content.md");
/** `<runDir>/plan/refs.json`: the run's copy of the `--refs` file. */
export const planRefsPath = (runDir: string): string => path.join(planDir(runDir), "refs.json");

/** A plan name: kebab-case, lowercase letters, digits and single hyphens. */
export const PLAN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The planned spec's repository path (git path, `/` separators). */
export const planSpecRel = (name: string): string => `docs/prd/${name}.md`;
/** The planned task folder's repository path (git path, `/` separators). */
export const planTasksRel = (name: string): string => `.agents/tasks/${name}`;

/** The run's integration worktree. */
export const integrationWorktreeOf = (runDir: string): string => path.join(runDir, "worktrees", "integration");

/** Where the run reads its spec and task folder: the integration worktree copies for a planned run. */
export function runInputs(state: RunState, runDir: string): { specPath: string; tasksDir: string } {
  const name = state.plan?.name;
  if (name !== undefined) {
    const wt = integrationWorktreeOf(runDir);
    return { specPath: path.join(wt, ...planSpecRel(name).split("/")), tasksDir: path.join(wt, ...planTasksRel(name).split("/")) };
  }
  if (state.specPath === undefined || state.tasksDir === undefined) {
    throw new Error(`run ${state.runId} has no spec and tasks yet (status ${state.status})`);
  }
  return { specPath: state.specPath, tasksDir: state.tasksDir };
}
