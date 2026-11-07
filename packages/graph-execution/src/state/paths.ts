import path from "node:path";

export const RUNS_DIR = ".graph-execution";
/** Internal: the folder holding run folders instead of `<repo>/.graph-execution` (suite feature runs). */
export const RUNS_ROOT_ENV = "GRAPH_EXECUTION_RUNS_ROOT";
/** Internal: the id of the new run instead of a generated one. */
export const RUN_ID_ENV = "GRAPH_EXECUTION_RUN_ID";
/**
 * Unsets, in an execa `env`, the variables that tie a process to the live run (its folder, id and launcher files).
 * Agents and gate commands get it: inheriting them, a project's own tests (this repo's) acted on the live run.
 */
export const RUN_ENV_UNSET = {
  [RUNS_ROOT_ENV]: undefined,
  [RUN_ID_ENV]: undefined,
  GRAPH_EXECUTION_READY_FILE: undefined,
  GRAPH_EXECUTION_TASK_NAME: undefined,
} as const;
export const RUN_ID_PATTERN =/^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function runsRoot(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env[RUNS_ROOT_ENV];
  return root ? path.resolve(root) : path.join(repo, RUNS_DIR);
}
