/** What an outside driver (the web page, tests) asked of a running suite. */
export type SuiteRequest = { retry: string } | { integrate: true } | { retryIntegration: true };

export type ControlResult = { ok: true } | { ok: false; reason: "not_failed" | "not_ready" | "unknown" };

/**
 * Meeting point between a running suite and whoever drives it from outside: the orchestrator publishes what is
 * allowed with `setAllowed` and takes accepted requests with `next`; the driver calls `retryFeature` and
 * `startIntegration`.
 */
export class SuiteControl {
  private allowedNow: { retry: string[]; integrate: boolean; retryIntegration: boolean } = { retry: [], integrate: false, retryIntegration: false };
  private readonly requests: SuiteRequest[] = [];
  private waiter: ((r: SuiteRequest | undefined) => void) | undefined;
  private quitted = false;
  private known = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** Orchestrator side: what is allowed now. `known` feature names are told apart from unknown ones in refusals. */
  setAllowed(a: { retry: string[]; integrate: boolean; retryIntegration?: boolean }, known?: string[]): void {
    this.allowedNow = { retry: [...a.retry], integrate: a.integrate, retryIntegration: a.retryIntegration ?? false };
    if (known) this.known = new Set(known);
    this.changed();
  }

  get allowed(): { retry: string[]; integrate: boolean; retryIntegration: boolean } {
    return { ...this.allowedNow, retry: [...this.allowedNow.retry] };
  }

  retryFeature(name: string): ControlResult {
    if (this.quitted) return { ok: false, reason: "not_ready" };
    if (!this.allowedNow.retry.includes(name)) {
      return { ok: false, reason: this.known.size > 0 && !this.known.has(name) ? "unknown" : "not_failed" };
    }
    // One request per failure: the feature is not offered again until the orchestrator says so.
    this.allowedNow = { ...this.allowedNow, retry: this.allowedNow.retry.filter((n) => n !== name) };
    this.push({ retry: name });
    this.changed();
    return { ok: true };
  }

  startIntegration(): ControlResult {
    if (this.quitted || !this.allowedNow.integrate) return { ok: false, reason: "not_ready" };
    this.allowedNow = { retry: [], integrate: false, retryIntegration: false };
    this.push({ integrate: true });
    this.changed();
    return { ok: true };
  }

  retryIntegration(): ControlResult {
    if (this.quitted || !this.allowedNow.retryIntegration) return { ok: false, reason: "not_ready" };
    this.allowedNow = { retry: [], integrate: false, retryIntegration: false };
    this.push({ retryIntegration: true });
    this.changed();
    return { ok: true };
  }

  /** Resolves with the next accepted request, in order; `undefined` after `quit()`. */
  next(): Promise<SuiteRequest | undefined> {
    const first = this.requests.shift();
    if (first) return Promise.resolve(first);
    if (this.quitted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  quit(): void {
    this.quitted = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
    this.changed();
  }

  /** Called whenever `allowed` changes; returns a function that removes the listener. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private push(r: SuiteRequest): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(r);
    } else this.requests.push(r);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
