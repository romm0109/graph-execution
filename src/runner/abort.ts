import path from "node:path";
import { AbortRunError, type ExitCode, exitCodeFor } from "../state/errors.js";
import type { StateStore } from "../state/state.js";

export const resumeCommand = (runId: string): string => `graph-execution --resume --run ${runId}`;

export interface AbortContext {
  store: StateStore;
  log: (line: string) => void;
}

/**
 * The shared abort path for exhausted retries and Ctrl+C (PRD §7.7): flushes the state and tells the user what
 * failed and how to resume. Worktrees, branches and logs are deliberately left in place.
 */
export async function abortRun(err: unknown, { store, log }: AbortContext): Promise<ExitCode> {
  await store.save();
  const runId = store.state.runId;
  const step = err instanceof AbortRunError ? err.step : "run";
  const hint = err instanceof AbortRunError ? err.hint : resumeCommand(runId);
  log(`aborted at ${step}: ${err instanceof Error ? err.message : String(err)}`);
  log(`state, worktrees and logs are kept in ${path.dirname(store.path)}`);
  log(`to resume: ${hint}`);
  return exitCodeFor(err);
}
