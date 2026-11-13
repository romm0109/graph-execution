import path from "node:path";
import { RunStore } from "../ui/store.js";
import { isAgentOutputLine, type UiHandle, type UiOptions } from "../ui/start.js";
import { WEB_HOST_ENV, WEB_PORT_ENV, WEB_TOKEN_ENV } from "../state/paths.js";
import { createWebServer } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The run page's listen address from `GRAPH_EXECUTION_WEB_HOST` / `GRAPH_EXECUTION_WEB_PORT` (default 127.0.0.1, any
 * free port), and the page token from `GRAPH_EXECUTION_WEB_TOKEN`. A non-loopback address requires a token: other
 * containers on a sandbox's network could otherwise drive the run (forged Host and no Origin pass those checks).
 */
export function listenFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; port: number; token?: string } {
  const host = env[WEB_HOST_ENV]?.trim() || "127.0.0.1";
  const token = env[WEB_TOKEN_ENV]?.trim() || undefined;
  if (!LOOPBACK.has(host) && token === undefined) throw new Error(`${WEB_HOST_ENV}=${host} needs ${WEB_TOKEN_ENV}`);
  const v = env[WEB_PORT_ENV]?.trim() ?? "";
  let port = 0;
  if (v !== "") {
    port = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`${WEB_PORT_ENV} must be a port number (0-65535), got '${v}'`);
    }
  }
  return token === undefined ? { host, port } : { host, port, token };
}

export type WebUiHandle = UiHandle & {
  url: string;
  close(): Promise<void>;
  closed: Promise<void>;
  setFatal(fatal: { message: string; hint?: string }): void;
  /** Re-attaches the running page to a new graph (a planned run's tasks), instead of starting a second server. */
  attach(opts: UiOptions): void;
};

/** Like `startUi`, but the run is shown by a local web page; the caller awaits the server and closes it. */
export async function startWebUi(opts: UiOptions): Promise<WebUiHandle> {
  let store =
    opts.store ??
    new RunStore(opts.events, { taskIds: opts.layers.flat(), merged: opts.merged, attempts: opts.attempts });
  let retry = opts.retry;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const web = await createWebServer({
    listen: listenFromEnv(),
    store,
    meta: {
      layers: opts.layers,
      parents: opts.parents ?? {},
      mergeTarget: opts.mergeTarget,
      runId: opts.runId,
      provider: opts.provider,
      startedAt: Date.now(),
      humanReview: opts.humanReview === true,
    },
    onAbort: opts.onAbort ?? (() => void process.kill(process.pid, "SIGINT")),
    retry: opts.retry,
    review: opts.retry,
    changes: opts.changes,
    ...(opts.runDir && opts.repo ? { human: { runDir: opts.runDir, repo: opts.repo } } : {}),
    ...(opts.runDir ? { logsDir: path.join(opts.runDir, "logs") } : {}),
    onClose: () => {
      retry?.quit();
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
    attach: (next) => {
      store =
        next.store ??
        new RunStore(next.events, { taskIds: next.layers.flat(), merged: next.merged, attempts: next.attempts });
      retry = next.retry ?? retry;
      web.setGraph({
        store,
        changes: next.changes,
        meta: { layers: next.layers, parents: next.parents ?? {}, mergeTarget: next.mergeTarget, humanReview: next.humanReview === true },
      });
    },
    close: async () => {
      await web.close();
      retry?.quit();
      store.dispose();
      markClosed();
    },
  };
}
