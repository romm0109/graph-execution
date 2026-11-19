// Public, stable surface for programs that read graph-execution runs (graph-manager). Never import cli.ts here:
// cli.ts runs `await main()` at top level.
import { fileURLToPath } from "node:url";

export { stateSchema, runStatusSchema, taskStatusSchema, planRefSchema, planStateSchema, type PlanRef, type PlanState, lockHolder, readLock, lockHost, isAlive, LOCK_FILE, type LockInfo, type RunState, type RunStatus, type TaskStatus } from "./state/state.js";
export { RUNS_DIR, RUN_ID_ENV, RUN_ID_PATTERN, TAKE_LOCK_FROM_ENV, runsRoot } from "./state/paths.js";
export { RUN_VALUE_OPTIONS, SANDBOX_ENV, SANDBOX_IMAGE_ENV, WEB_HOST_ENV, WEB_PORT_ENV, WEB_TOKEN_ENV } from "./state/paths.js";
export { scan, type RunEntry, type RunKind, type Scan, type ScanOptions } from "./cleanup/scan.js";
export { readWebJson, webJsonPath, type WebJson } from "./web/webjson.js";
export { suiteStateSchema, SUITE_FILE } from "./suite/state.js";
export type { NodeStatus, NodeView, ViewState } from "./ui/store.js";
export {
  BUILTIN_REVIEWERS,
  BUILTIN_INSTRUCTIONS,
  REVIEWERS_ENV,
  RUN_REVIEWERS_FILE,
  REVIEWER_PROVIDERS,
  RESERVED_REVIEWER_IDS,
  reviewerSchema,
  reviewersFileSchema,
  parseReviewers,
  matchFiles,
  checkGlob,
  type Reviewer,
  type ReviewerInput,
} from "./review/reviewers.js";
export { EXIT_SUCCESS, EXIT_REVIEW_FAILED, EXIT_ABORT, EXIT_HANDOFF_BLOCKED, EXIT_NEEDS_INFO, EXIT_AWAITING_APPROVAL, type ExitCode } from "./state/errors.js";

/** Absolute path of the CLI entry, for programs that spawn it. */
export const CLI_PATH: string = fileURLToPath(new URL("./cli.js", import.meta.url));
export { planSpecRel, planTasksRel, PLAN_DIR } from "./plan/paths.js";
export { renameReplacing } from "./fs/rename.js";
// The shared terminal's server side (src/terminal); node-pty loads only when a session is created.
export {
  SCROLLBACK_MAX,
  createPtySession,
  createPtySessionSync,
  bridgeSocket,
  clientMessageSchema,
  batchOutput,
  OUTPUT_BATCH_MS,
  fixSpawnHelper,
  nodePtyDir,
  type PtyAttachment,
  type PtyListener,
  type PtyModule,
  type PtySession,
  type PtySessionOptions,
  type BridgeSocket,
  type BridgeTarget,
  type ClientMessage,
  type OutputBatcher,
} from "./terminal/index.js";
// Escalations and their resolutions (docs/prd/escalation.md): the CLI and the closed harness resolve through these.
export { escalationFileSchema, escalationRecordSchema, type EscalationFile, type EscalationRecord } from "./escalation/schema.js";
export { loadEscalations } from "./escalation/store.js";
export {
  resolutionSchema,
  checkResolution,
  applyResolution,
  applyResolutionOffline,
  ResolutionError,
  type Resolution,
} from "./escalation/resolve.js";
