import type { AgentEvent, AgentRun, Provider } from "../providers/types.js";

/** An agent printed nothing for too long and was stopped. */
export class IdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Wraps `provider` so an agent that produces no output for `minutes` is stopped: its process is killed as on an abort and
 * its `done` rejects with `IdleTimeoutError`, a failed attempt of class `idle`. 0 disables the timeout. Only the agent
 * is stopped; the run's own signal is untouched.
 */
export function watchIdle(provider: Provider, minutes: number, onIdle?: (label: string, why: string) => void): Provider {
  if (minutes <= 0) return provider;
  const limitMs = minutes * 60_000;
  return {
    name: provider.name,
    run(opts): AgentRun {
      const own = new AbortController();
      const relay = (): void => own.abort(opts.signal.reason);
      if (opts.signal.aborted) own.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", relay, { once: true });
      const agent = provider.run({ ...opts, signal: own.signal });
      let idle: IdleTimeoutError | undefined;
      let timer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      const arm = (): void => {
        stop();
        timer = setTimeout(() => {
          const why = `it produced no output for ${minutes} minute${minutes === 1 ? "" : "s"}`;
          idle = new IdleTimeoutError(`the agent was stopped because ${why}`);
          onIdle?.(opts.label, why);
          own.abort(idle);
        }, limitMs);
        timer.unref();
      };
      arm();

      async function* events(): AsyncGenerator<AgentEvent> {
        try {
          for await (const event of agent.events) {
            if (!idle) arm();
            yield event;
          }
        } finally {
          stop();
          opts.signal.removeEventListener("abort", relay);
        }
      }
      const done = agent.done.then(
        (result) => {
          stop();
          if (idle) throw idle;
          return result;
        },
        (err) => {
          stop();
          throw idle ?? err;
        },
      );
      done.catch(() => {});
      return { events: events(), done };
    },
  };
}
