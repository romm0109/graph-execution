/** One run's origin: the terminal that started (or last resumed) it. */
export interface RunOrigin {
  wsId: string;
  runId: string;
  terminalId: string;
  /** Bumped on every `set`: the watcher compares it to tell a new start or resume from the one it already diffed. */
  epoch: number;
  /** When the origin was set (ms since the epoch). */
  setAt: number;
  /**
   * When the run was resumed by this origin's caller (resume_run, `--resume --run` through the shim, a sandbox resume):
   * the watcher then reports `resumed` and the resumed attempt's end even when the status didn't change between polls.
   */
  resumedAt?: number;
}

export interface SetOriginOptions {
  /** The run is being resumed, at this time (ms); taken before the engine starts, so its first write is newer. */
  resumedAt?: number;
}

/** Which terminal started each run (docs/prd/agent-supervisor.md). In memory: terminals don't survive a restart either. */
export class RunOrigins {
  private readonly map = new Map<string, RunOrigin>();
  private epoch = 0;
  private static key(wsId: string, runId: string): string {
    return `${wsId}/${runId}`;
  }
  /** Records (or replaces: `resume_run` makes the caller the new origin) the terminal that started a run. */
  set(wsId: string, runId: string, terminalId: string, opts: SetOriginOptions = {}): void {
    this.map.set(RunOrigins.key(wsId, runId), {
      wsId,
      runId,
      terminalId,
      epoch: ++this.epoch,
      setAt: Date.now(),
      ...(opts.resumedAt !== undefined ? { resumedAt: opts.resumedAt } : {}),
    });
  }
  get(wsId: string, runId: string): string | undefined {
    return this.map.get(RunOrigins.key(wsId, runId))?.terminalId;
  }
  delete(wsId: string, runId: string): void {
    this.map.delete(RunOrigins.key(wsId, runId));
  }
  entries(): RunOrigin[] {
    return [...this.map.values()].map((e) => ({ ...e }));
  }
}
