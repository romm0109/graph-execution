export type RetryResult = { ok: true } | { ok: false; reason: "not_waiting" | "not_retryable" | "not_mergeable" };

/** What the driver chose while the run waits: retry a failed node, or merge what was done so far and end. */
export type RetryChoice = { retry: string } | { merge: true };

/**
 * Meeting point between a run that waits after a failure and whoever drives the retry (terminal key, web button,
 * tests): the run calls `wait`, the driver answers with `retryNode` or `quit`.
 */
export class RetryHub {
  private pending:
    | { nodes: readonly string[]; mergeable: boolean; resolve: (choice: RetryChoice | undefined) => void }
    | undefined;
  private quitted = false;
  private waiting: { promise: Promise<readonly string[]>; resolve: (nodes: readonly string[]) => void } | undefined;
  private readonly listeners = new Set<() => void>();

  /** The nodes that can be retried now; empty while the run is going. */
  get retryable(): readonly string[] {
    return this.pending?.nodes ?? [];
  }

  /** True while the run waits and offers to merge what was done so far into the starting branch. */
  get mergeable(): boolean {
    return this.pending?.mergeable ?? false;
  }

  /** Run side: resolves with the driver's choice, or `undefined` after `quit()`. */
  wait(nodes: readonly string[], mergeable = false): Promise<RetryChoice | undefined> {
    if (this.quitted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.pending = { nodes: [...nodes], mergeable, resolve };
      this.waiting?.resolve(this.pending.nodes);
      this.waiting = undefined;
      this.changed();
    });
  }

  retryNode(id: string): RetryResult {
    const pending = this.pending;
    if (!pending) return { ok: false, reason: "not_waiting" };
    if (!pending.nodes.includes(id)) return { ok: false, reason: "not_retryable" };
    this.pending = undefined;
    pending.resolve({ retry: id });
    this.changed();
    return { ok: true };
  }

  /** Applies the integration branch to the starting branch as it is and ends the run, instead of retrying. */
  mergeNow(): RetryResult {
    const pending = this.pending;
    if (!pending) return { ok: false, reason: "not_waiting" };
    if (!pending.mergeable) return { ok: false, reason: "not_mergeable" };
    this.pending = undefined;
    pending.resolve({ merge: true });
    this.changed();
    return { ok: true };
  }

  quit(): void {
    this.quitted = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(undefined);
    this.changed();
  }

  /** Resolves when a wait starts (at once when one is pending already). */
  whenWaiting(): Promise<readonly string[]> {
    if (this.pending) return Promise.resolve(this.pending.nodes);
    if (!this.waiting) {
      let resolve!: (nodes: readonly string[]) => void;
      const promise = new Promise<readonly string[]>((r) => (resolve = r));
      this.waiting = { promise, resolve };
    }
    return this.waiting.promise;
  }

  /** Called whenever `retryable` changes; returns a function that removes the listener. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
