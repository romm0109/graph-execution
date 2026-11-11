import path from "node:path";

export const RUNS_DIR = ".graph-execution";
/** Internal: the folder holding run folders instead of `<repo>/.graph-execution` (suite feature runs). */
export const RUNS_ROOT_ENV = "GRAPH_EXECUTION_RUNS_ROOT";
/** Internal: the id of the new run instead of a generated one. */
export const RUN_ID_ENV = "GRAPH_EXECUTION_RUN_ID";
/** Internal (graph-manager): the host whose run lock and agent records this process may take over (its sandbox container is gone). */
export const TAKE_LOCK_FROM_ENV = "GRAPH_EXECUTION_TAKE_LOCK_FROM";
/** Internal (graph-manager): set to "1" in a sandbox container; a new run records `sandbox` in state.json, and `--resume` of a sandboxed run requires it. */
export const SANDBOX_ENV = "GRAPH_EXECUTION_SANDBOX";
/** Internal (graph-manager): the sandbox's image, recorded as `sandbox.image`. */
export const SANDBOX_IMAGE_ENV = "GRAPH_EXECUTION_SANDBOX_IMAGE";
/** Internal: the sandbox settings of a `graph-execution --sandbox` run (JSON), recorded in state.json's `sandbox`. */
export const SANDBOX_SETTINGS_ENV = "GRAPH_EXECUTION_SANDBOX_SETTINGS";
/** The run page's bind address and port (default 127.0.0.1 and 0 = any free port). */
export const WEB_HOST_ENV = "GRAPH_EXECUTION_WEB_HOST";
export const WEB_PORT_ENV = "GRAPH_EXECUTION_WEB_PORT";
/** Internal (graph-manager): a secret the run page requires in `x-graph-execution-token`; needed with a non-loopback WEB_HOST. */
export const WEB_TOKEN_ENV = "GRAPH_EXECUTION_WEB_TOKEN";
/** Internal (graph-manager): the host port a sandbox's run page is published on; Host and Origin on it are accepted too. */
export const WEB_PUBLIC_PORT_ENV = "GRAPH_EXECUTION_WEB_PUBLIC_PORT";
/**
 * Unsets, in an execa `env`, the variables that tie a process to the live run (its folder, id and launcher files).
 * Agents and gate commands get it: inheriting them, a project's own tests (this repo's) acted on the live run.
 */
export const RUN_ENV_UNSET = {
  [RUNS_ROOT_ENV]: undefined,
  [RUN_ID_ENV]: undefined,
  [TAKE_LOCK_FROM_ENV]: undefined,
  [SANDBOX_ENV]: undefined,
  [SANDBOX_IMAGE_ENV]: undefined,
  [SANDBOX_SETTINGS_ENV]: undefined,
  [WEB_HOST_ENV]: undefined,
  [WEB_PORT_ENV]: undefined,
  [WEB_TOKEN_ENV]: undefined,
  [WEB_PUBLIC_PORT_ENV]: undefined,
  GRAPH_EXECUTION_READY_FILE: undefined,
  GRAPH_EXECUTION_TASK_NAME: undefined,
  // Set on a delegated engine (launch/delegate.ts); an agent's own `npx graph-execution` must still delegate.
  GRAPH_EXECUTION_DELEGATED: undefined,
} as const;
/**
 * The options of the run command (`graph-execution <tasks-dir> …`) that take a value, for programs that scan its
 * arguments (graph-manager's `--sandbox`). cli.test.ts keeps it in sync with the CLI's `--help`.
 */
export const RUN_VALUE_OPTIONS: readonly string[] = [
  "--spec",
  "--provider",
  "--concurrency",
  "--model",
  "--run",
  "--attempts",
  "--fix-passes",
  "--validation-rounds",
  "--validate-at",
  "--idle-timeout",
  "--reviewers",
  "--review-provider",
  "--review-model",
  "--sandbox-image",
  "--sandbox-base",
  "--sandbox-line",
  "--sandbox-cpus",
  "--sandbox-memory",
  "--sandbox-pids",
];
export const RUN_ID_PATTERN =/^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function runsRoot(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env[RUNS_ROOT_ENV];
  return root ? path.resolve(root) : path.join(repo, RUNS_DIR);
}
