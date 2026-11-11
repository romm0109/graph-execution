import path from "node:path";
import { RunStore } from "../ui/store.js";
import { isAgentOutputLine, type UiHandle, type UiOptions } from "../ui/start.js";
import { WEB_HOST_ENV, WEB_PORT_ENV, WEB_PUBLIC_PORT_ENV, WEB_TOKEN_ENV } from "../state/paths.js";
import { createWebServer } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The run page's listen address from `GRAPH_EXECUTION_WEB_HOST` / `GRAPH_EXECUTION_WEB_PORT` (default 127.0.0.1, any
 * free port), and the page token from `GRAPH_EXECUTION_WEB_TOKEN`. A non-loopback address requires a token: other
 * containers on a sandbox's network could otherwise drive the run (forged Host and no Origin pass those checks).
 * `GRAPH_EXECUTION_WEB_PUBLIC_PORT`: the host port the page is published on (a sandbox), accepted in Host and Origin.
 */
export function listenFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; port: number; token?: string; publicPort?: number } {
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
  const pv = env[WEB_PUBLIC_PORT_ENV]?.trim() ?? "";
  let publicPort: number | undefined;
  if (pv !== "") {
    publicPort = /^\d+$/.test(pv) ? Number(pv) : NaN;
    if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
      throw new Error(`${WEB_PUBLIC_PORT_ENV} must be a port number (1-65535), got '${pv}'`);
    }
  }
  return { host, port, ...(token === undefined ? {} : { token }), ...(publicPort === undefined ? {} : { publicPort }) };
}

export type WebUiHandle = UiHandle & { url: string; close(): Promise<void>; closed: Promise<void>; setFatal(fatal: { message: string; hint?: string }): void };

/** Like `startUi`, but the run is shown by a local web page; the caller awaits the server and closes it. */
export async function startWebUi(opts: UiOptions): Promise<WebUiHandle> {
  const store =
    opts.store ??
    new RunStore(opts.events, { taskIds: opts.layers.flat(), merged: opts.merged, attempts: opts.attempts });
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
