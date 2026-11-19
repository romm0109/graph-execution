import type { GraphUpdate } from "../scheduler/scheduler.js";

export type RetryResult = { ok: true } | { ok: false; reason: "not_waiting" | "not_retryable" | "not_mergeable" };

/** The answer to a submitted resolution, once the run process applied or refused it. */
export type ResolveResult =
  | { ok: true; requeued: string[] }
  | { ok: false; status: 400 | 409; code: string; message: string };

export type ResolutionHandler = (raw: unknown) => Promise<ResolveResult>;

/** What the driver chose while the run waits: retry a failed node, or merge what was done so far and end. */
export type RetryChoice = { retry: string } | { merge: true };

/** What the human chose while the run waits for the review. */
export type ReviewChoice = { review: "apply"; force?: boolean } | { review: "drop" } | { review: "changes" };

/**
 * Meeting point between a run that waits after a failure and whoever drives the retry (terminal key, web button,
 * tests): the run calls `wait`, the driver answers with `retryNode` or `quit`.
 */
export class RetryHub {
  private pending:
    | { nodes: readonly string[]; mergeable: boolean; resolve: (choice: RetryChoice | undefined) => void }
    | undefined;
  private review: { resolve: (choice: ReviewChoice | undefined) => void } | undefined;
  private reviewWaiter: { promise: Promise<void>; resolve: () => void } | undefined;
  private quitted = false;
  private waiting: { promise: Promise<readonly string[]>; resolve: (nodes: readonly string[]) => void } | undefined;
  private readonly listeners = new Set<() => void>();
  private resolution: { resolve: (update: GraphUpdate | undefined) => void } | undefined;
  private resolutionWaiter: { promise: Promise<void>; resolve: () => void } | undefined;
  private resolutionHandler: ResolutionHandler | undefined;
  /** Submitted resolutions are handled one after another, each against the task set at that moment. */
  private resolutionQueue: Promise<unknown> = Promise.resolve();

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

  /** True while the run waits for the human's review decision. */
  get reviewWaiting(): boolean {
    return this.review !== undefined;
  }

  /** Run side: waits for the human's decision; `undefined` after `quit()`. */
  waitReview(): Promise<ReviewChoice | undefined> {
    if (this.quitted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.review = { resolve };
      this.reviewWaiter?.resolve();
      this.reviewWaiter = undefined;
      this.changed();
    });
  }

  /** Driver side: answers a pending review wait. */
  decide(choice: ReviewChoice): RetryResult {
    const review = this.review;
    if (!review) return { ok: false, reason: "not_waiting" };
    this.review = undefined;
    review.resolve(choice);
    this.changed();
    return { ok: true };
  }

  /** Resolves when a review wait starts (at once when one is pending already). */
  whenReviewWaiting(): Promise<void> {
    if (this.review) return Promise.resolve();
    if (!this.reviewWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.reviewWaiter = { promise, resolve };
    }
    return this.reviewWaiter.promise;
  }

  /** True while the run waits for a resolution of an escalation. */
  get escalationWaiting(): boolean {
    return this.resolution !== undefined;
  }

  /** Run side: waits for the next applied resolution's effect on the graph; `undefined` after `quit()`. */
  waitResolution(): Promise<GraphUpdate | undefined> {
    if (this.quitted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.resolution = { resolve };
      this.resolutionWaiter?.resolve();
      this.resolutionWaiter = undefined;
      this.changed();
    });
  }

  /** Driver side: hands an applied resolution's graph update to the waiting run. */
  deliverResolution(update: GraphUpdate): RetryResult {
    const resolution = this.resolution;
    if (!resolution) return { ok: false, reason: "not_waiting" };
    this.resolution = undefined;
    resolution.resolve(update);
    this.changed();
    return { ok: true };
  }

  /**
   * Driver side (web route, CLI, harness): queues a resolution and resolves with the run's answer. Without a live
   * run (no handler registered) it is refused with `409 not_waiting`.
   */
  submitResolution(raw: unknown): Promise<ResolveResult> {
    const result = this.resolutionQueue.then(async (): Promise<ResolveResult> => {
      const handler = this.resolutionHandler;
      if (!handler || this.quitted) return { ok: false, status: 409, code: "not_waiting", message: "the run is not live" };
      return handler(raw);
    });
    this.resolutionQueue = result.catch(() => undefined);
    return result;
  }

  /** Run side: handles submitted resolutions from now on; returns a function that unregisters it. */
  onResolution(handler: ResolutionHandler): () => void {
    this.resolutionHandler = handler;
    return () => {
      if (this.resolutionHandler === handler) this.resolutionHandler = undefined;
    };
  }

  /** Resolves when a resolution wait starts (at once when one is pending already). */
  whenEscalationWaiting(): Promise<void> {
    if (this.resolution) return Promise.resolve();
    if (!this.resolutionWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.resolutionWaiter = { promise, resolve };
    }
    return this.resolutionWaiter.promise;
  }

  quit(): void {
    this.quitted = true;
    const resolution = this.resolution;
    this.resolution = undefined;
    resolution?.resolve(undefined);
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(undefined);
    const review = this.review;
    this.review = undefined;
    review?.resolve(undefined);
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
