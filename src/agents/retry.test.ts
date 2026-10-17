import { describe, expect, it, vi } from "vitest";
import { AbortRunError, InterruptedError, RetriesExhaustedError, exitCodeFor } from "../state/errors.js";
import { withRetries, type CheckResult } from "./retry.js";

const ok = <V>(value: V): CheckResult<V> => ({ ok: true, value });
const crash: CheckResult<never> = { ok: false, reason: { class: "crash", message: "exit 1" } };

function setup(results: Array<CheckResult<string> | Error>, signal = new AbortController().signal) {
  const prepare = vi.fn<(attempt: number) => Promise<void>>(async () => {});
  const onAttempt = vi.fn();
  const execute = vi.fn(async (attempt: number) => {
    const r = results[attempt - 1]!;
    if (r instanceof Error) throw r;
    return r;
  });
  const promise = withRetries({
    label: "task 1",
    hint: "graph-execution --resume --run x",
    signal,
    prepare,
    execute,
    check: async (r) => r,
    onAttempt,
  });
  return { promise, prepare, execute, onAttempt };
}

describe("withRetries", () => {
  it("returns the first successful attempt's value", async () => {
    const { promise, prepare, onAttempt } = setup([crash, ok("done")]);
    expect(await promise).toBe("done");
    expect(prepare.mock.calls).toEqual([[1], [2]]);
    expect(onAttempt.mock.calls).toEqual([[1, undefined], [2, { class: "crash", message: "exit 1" }]]);
  });

  it("counts a thrown error as a crash", async () => {
    const { promise, onAttempt } = setup([new Error("spawn failed"), ok("done")]);
    expect(await promise).toBe("done");
    expect(onAttempt.mock.calls[1]).toEqual([2, { class: "crash", message: "spawn failed" }]);
  });

  it("throws RetriesExhaustedError with the step and hint after the last failed attempt", async () => {
    const noCommit: CheckResult<string> = { ok: false, reason: { class: "no_commit", message: "no commit" } };
    const { promise, execute } = setup([crash, crash, noCommit]);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetriesExhaustedError);
    expect(err).toBeInstanceOf(AbortRunError);
    expect(err).toMatchObject({ step: "task 1", hint: "graph-execution --resume --run x" });
    expect((err as Error).message).toBe("task 1 failed after 3 attempts: no commit (no_commit)");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(exitCodeFor(err)).toBe(2);
  });

  it("stops at once on abort without counting the attempt or starting another", async () => {
    const controller = new AbortController();
    const onAttempt = vi.fn();
    const execute = vi.fn(async () => {
      controller.abort();
      return 1;
    });
    const err = await withRetries({
      label: "task 1",
      hint: "h",
      signal: controller.signal,
      prepare: async () => {},
      execute,
      check: async () => crash,
      onAttempt,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InterruptedError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { promise, prepare } = setup([ok("x")], controller.signal);
    await expect(promise).rejects.toBeInstanceOf(InterruptedError);
    expect(prepare).not.toHaveBeenCalled();
  });
});
