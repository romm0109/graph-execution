import type { Report } from "../review/report.js";

/** The only exit codes the CLI ever uses (PRD §7.11, §11). */
export const EXIT_SUCCESS = 0;
/** Open blockers or majors remain after the last fix pass (PRD §7.6). */
export const EXIT_REVIEW_FAILED = 1;
/** Abort or startup failure; everything is kept for `--resume`. */
export const EXIT_ABORT = 2;

/** `--web` could not hand the run to the OS; the foreground command is printed instead. */
export const EXIT_HANDOFF_BLOCKED = 3;

/** The run finished but the code review was not performed (the reviewer ran out of attempts): the result is unreviewed. */
export const EXIT_UNREVIEWED = 4;

export type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_REVIEW_FAILED
  | typeof EXIT_ABORT
  | typeof EXIT_HANDOFF_BLOCKED
  | typeof EXIT_UNREVIEWED;

export interface AbortInfo {
  /** What failed, e.g. `task 2`. */
  step: string;
  /** How to resume, e.g. the exact `--resume` command. */
  hint: string;
}

/** An error that aborts the run through the shared abort path (PRD §7.7). */
export class AbortRunError extends Error {
  readonly step: string;
  readonly hint: string;

  constructor(message: string, info: AbortInfo, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.step = info.step;
    this.hint = info.hint;
  }
}

/** A step ran out of attempts. */
export class RetriesExhaustedError extends AbortRunError {
  /** For a live test: the last report that was valid but did not cover the test plan. */
  lastReport?: Report;
}

/** The run was interrupted (Ctrl+C, SIGTERM or an aborted signal); not a failed attempt. */
export class InterruptedError extends AbortRunError {}

/** Every error ends the run as an abort; review-loop exhaustion (exit 1) is not an error. */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof AbortRunError) return EXIT_ABORT;
  return EXIT_ABORT;
}
