import { RunStore } from "../ui/store.js";
import { isAgentOutputLine, type UiHandle, type UiOptions } from "../ui/start.js";
import { createWebServer } from "./server.js";

export type WebUiHandle = UiHandle & { url: string; close(): Promise<void>; closed: Promise<void>; setFatal(fatal: { message: string; hint?: string }): void };

/** Like `startUi`, but the run is shown by a local web page; the caller awaits the server and closes it. */
export async function startWebUi(opts: UiOptions): Promise<WebUiHandle> {
  const store =
    opts.store ??
    new RunStore(opts.events, { taskIds: opts.layers.flat(), merged: opts.merged, attempts: opts.attempts });
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const web = await createWebServer({
    store,
    meta: {
      layers: opts.layers,
      parents: opts.parents ?? {},
      mergeTarget: opts.mergeTarget,
      runId: opts.runId,
      provider: opts.provider,
      startedAt: Date.now(),
    },
    onAbort: opts.onAbort ?? (() => void process.kill(process.pid, "SIGINT")),
    retry: opts.retry,
    review: opts.retry,
    changes: opts.changes,
    ...(opts.runDir && opts.repo ? { human: { runDir: opts.runDir, repo: opts.repo } } : {}),
    onClose: () => {
      opts.retry?.quit();
      store.dispose();
      markClosed();
    },
  });
  return {
    url: web.url,
    closed,
    log: (line) => {
      if (!isAgentOutputLine(line)) store.addEvent(line);
    },
    // The page keeps serving the final state; `close` shuts the server.
    stop: async () => {},
    setFatal: web.setFatal,
    close: async () => {
      await web.close();
      opts.retry?.quit();
      store.dispose();
      markClosed();
    },
  };
}
