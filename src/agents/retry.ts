import { AbortRunError, InterruptedError, RetriesExhaustedError } from "../state/errors.js";
import { IdleTimeoutError } from "./idle.js";
import { LoopDetectedError } from "./loop.js";

/**
 * Why an attempt failed (PRD §7.7). Later agents extend the union with their own classes. `loop`: the agent kept
 * repeating the same tool calls and was stopped (`watchLoops`). `idle`: it printed nothing for too long (`watchIdle`).
 */
export type FailureClass = "crash" | "no_commit" | "invalid_report" | "conflict_markers" | "loop" | "idle";

export interface AttemptFailure {
  class: FailureClass;
  message: string;
}

export type CheckResult<V> = { ok: true; value: V } | { ok: false; reason: AttemptFailure };

export interface RetryOptions<R, V> {
  attempts?: number;
  /** Names the step in errors, e.g. `task 2`. */
  label: string;
  /** How to resume after an abort; carried by the thrown `AbortRunError`. */
  hint: string;
  signal: AbortSignal;
  /** Sets up a fresh workspace for attempt `n` (1-based), discarding any previous attempt's. */
  prepare: (attempt: number) => Promise<void>;
  /** Runs the agent. A thrown error counts as a crash. */
  execute: (attempt: number) => Promise<R>;
  check: (result: R, attempt: number) => Promise<CheckResult<V>>;
  /** Called before attempt `n` starts, with the failure of the previous attempt when it is a retry. */
  onAttempt?: (attempt: number, previous?: AttemptFailure) => Promise<void> | void;
}

/**
 * Runs an agent invocation up to `attempts` times (PRD §6). Exhaustion throws `RetriesExhaustedError`;
 * an aborted `signal` throws `InterruptedError` at once without counting as a failed attempt.
 */
export async function withRetries<R, V>(opts: RetryOptions<R, V>): Promise<V> {
  const attempts = opts.attempts ?? 3;
  const interrupted = (): InterruptedError =>
    new InterruptedError(`${opts.label} was interrupted`, { step: opts.label, hint: opts.hint });

  let previous: AttemptFailure | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal.aborted) throw interrupted();
    await opts.onAttempt?.(attempt, previous);
    await opts.prepare(attempt);
    if (opts.signal.aborted) throw interrupted();

    let outcome: CheckResult<V>;
    try {
      const result = await opts.execute(attempt);
      if (opts.signal.aborted) throw interrupted();
      outcome = await opts.check(result, attempt);
    } catch (err) {
      if (err instanceof AbortRunError) throw err;
      if (opts.signal.aborted) throw interrupted();
      outcome = {
        ok: false,
        reason: {
          class: err instanceof LoopDetectedError ? "loop" : err instanceof IdleTimeoutError ? "idle" : "crash",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (outcome.ok) return outcome.value;
    previous = outcome.reason;
  }
  throw new RetriesExhaustedError(
    `${opts.label} failed after ${attempts} attempts: ${previous!.message} (${previous!.class})`,
    { step: opts.label, hint: opts.hint },
  );
}
