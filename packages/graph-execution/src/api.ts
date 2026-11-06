// Public, stable surface for programs that read graph-execution runs (graph-manager). Never import cli.ts here:
// cli.ts runs `await main()` at top level.
import { fileURLToPath } from "node:url";

export { stateSchema, runStatusSchema, taskStatusSchema, lockHolder, isAlive, LOCK_FILE, type RunState, type RunStatus, type TaskStatus } from "./state/state.js";
export { RUNS_DIR, RUN_ID_ENV, RUN_ID_PATTERN, runsRoot } from "./state/paths.js";
export { scan, type RunEntry, type RunKind, type Scan } from "./cleanup/scan.js";
export { readWebJson, webJsonPath, type WebJson } from "./web/webjson.js";
export { suiteStateSchema, SUITE_FILE } from "./suite/state.js";
export type { NodeStatus, NodeView, ViewState } from "./ui/store.js";
export { EXIT_SUCCESS, EXIT_REVIEW_FAILED, EXIT_ABORT, EXIT_HANDOFF_BLOCKED, type ExitCode } from "./state/errors.js";

/** Absolute path of the CLI entry, for programs that spawn it. */
export const CLI_PATH: string = fileURLToPath(new URL("./cli.js", import.meta.url));
