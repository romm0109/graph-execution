import path from "node:path";

export const RUNS_DIR = ".graph-execution";
/** Internal: the folder holding run folders instead of `<repo>/.graph-execution` (suite feature runs). */
export const RUNS_ROOT_ENV = "GRAPH_EXECUTION_RUNS_ROOT";
/** Internal: the id of the new run instead of a generated one. */
export const RUN_ID_ENV = "GRAPH_EXECUTION_RUN_ID";
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function runsRoot(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env[RUNS_ROOT_ENV];
  return root ? path.resolve(root) : path.join(repo, RUNS_DIR);
}
