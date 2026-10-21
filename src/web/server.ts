import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChangeTracker } from "../runner/changes.js";
import type { RetryHub } from "../runner/retry-hub.js";
import { graphModel } from "../ui/model.js";
import type { RunStore } from "../ui/store.js";
import { summaryContent } from "../ui/Summary.js";

export interface WebMeta {
  /** Task ids per execution layer. */
  layers: string[][];
  parents: Record<string, readonly string[]>;
  mergeTarget?: string;
  runId: string;
  provider: string;
  startedAt: number;
}

export interface WebServerOptions {
  store: RunStore;
  meta: WebMeta;
  pageFile?: URL | string;
  /** `POST /abort` while the run is going: same effect as Ctrl+C. */
  onAbort(): void;
  /** `POST /close` after the run ended, once the response is sent and the server is closing. */
  onClose(): void;
  /** `POST /retry/<id>`: re-runs a failed node while the run waits. */
  retry?: Pick<RetryHub, "retryNode"> & Partial<Pick<RetryHub, "mergeNow">>;
  /** `GET /changes/<id>?file=`: diff text of a node's changed file. */
  changes?: Pick<ChangeTracker, "fileDiff">;
}

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** A fatal error after the server is up: the page shows it and allows Close. */
  setFatal(fatal: { message: string; hint?: string }): void;
  server: http.Server;
}

/** At most one `state` event per this many ms per client. */
const SSE_THROTTLE_MS = 100;
const PING_MS = 15_000;

export async function createWebServer({
  store,
  meta,
  pageFile = new URL("./page.html", import.meta.url),
  onAbort,
  onClose,
  retry,
  changes,
}: WebServerOptions): Promise<WebServer> {
  const clients = new Set<http.ServerResponse>();
  let port = 0;
  let fatal: { message: string; hint?: string } | undefined;

  const snapshot = (): string => {
    const state = store.getState();
    const model = graphModel({ layers: meta.layers, parents: meta.parents, state, mergeTarget: meta.mergeTarget });
    return JSON.stringify({
      ...state,
      graph: {
        nodes: [...model.nodes].map(([id, n]) => ({ id, title: n.title, view: n.view })),
        layers: model.layers,
        parents: model.parents,
      },
      runId: meta.runId,
      provider: meta.provider,
      mergeTarget: meta.mergeTarget,
      startedAt: meta.startedAt,
      fatal,
      summaryContent: state.summary ? summaryContent(state.summary) : undefined,
    });
  };

  type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
  const json = (res: http.ServerResponse, status: number, body: object): http.ServerResponse =>
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  const routes: Record<string, Route> = {
    "GET /": async (_req, res) => {
      const html = await readFile(pageFile);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    },
    "GET /state": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(snapshot());
    },
    "GET /events": (req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const send = (): void => void res.write(`event: state\ndata: ${snapshot()}\n\n`);
      send();
      clients.add(res);
      let timer: NodeJS.Timeout | undefined;
      let last = 0;
      const unsubscribe = store.subscribe(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          last = Date.now();
          send();
        }, Math.max(0, SSE_THROTTLE_MS - (Date.now() - last)));
      });
      const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
      req.on("close", () => {
        unsubscribe();
        clearInterval(ping);
        if (timer) clearTimeout(timer);
        clients.delete(res);
      });
    },
    "POST /abort": (_req, res) => {
      if (store.getState().summary !== undefined || fatal) return void json(res, 409, { error: "the run has ended" });
      onAbort();
      json(res, 200, { ok: true });
    },
    "POST /merge": (_req, res) => {
      const result = store.getState().mergeable && retry?.mergeNow ? retry.mergeNow() : undefined;
      if (!result || !result.ok) return void json(res, 409, { error: "there is nothing to merge now" });
      json(res, 200, { ok: true });
    },
    "POST /close": (_req, res) => {
      if (store.getState().summary === undefined && !fatal) return void json(res, 409, { error: "the run is still going" });
      // Close only after the response is flushed, or the browser sees a network error.
      res.once("finish", () => {
        void closeServer().then(onClose);
      });
      json(res, 200, { ok: true });
    },
  };

  const retryRoute = (id: string, res: http.ServerResponse): void => {
    if (!graphModel({ layers: meta.layers, parents: meta.parents, state: store.getState(), mergeTarget: meta.mergeTarget }).nodes.has(id)) {
      return void json(res, 404, { error: `unknown node ${id}` });
    }
    const result = store.getState().retryable.includes(id) && retry ? retry.retryNode(id) : undefined;
    if (!result || !result.ok) return void json(res, 409, { error: `${id} is not failed` });
    json(res, 200, { ok: true });
  };

  const changesRoute = async (id: string, file: string | null, res: http.ServerResponse): Promise<void> => {
    const node = graphModel({ layers: meta.layers, parents: meta.parents, state: store.getState(), mergeTarget: meta.mergeTarget }).nodes.get(id);
    if (!node) return void json(res, 404, { error: `unknown node ${id}` });
    const files = node.view.changes?.files ?? [];
    if (file === null) return void json(res, 200, { files });
    // Only paths from the node's own change list reach the tracker.
    if (!files.some((f) => f.path === file)) return void json(res, 400, { error: "unknown file" });
    const diff = await changes?.fileDiff(id, file);
    if (!diff) return void json(res, 404, { error: `no diff for ${file}` });
    json(res, 200, diff);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? "")) return void res.writeHead(421).end("Misdirected Request");
    const origin = req.headers.origin;
    if (req.method === "POST" && origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      return void res.writeHead(403).end("Forbidden");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (req.method === "GET" && pathname.startsWith("/changes/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/changes/".length));
      } catch {
        return void json(res, 404, { error: "unknown node" });
      }
      return changesRoute(id, url.searchParams.get("file"), res);
    }
    if (req.method === "POST" && pathname.startsWith("/retry/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/retry/".length));
      } catch {
        return void json(res, 404, { error: "unknown node" });
      }
      return retryRoute(id, res);
    }
    const route = routes[`${req.method} ${pathname}`];
    if (route) return void (await route(req, res));
    const known = pathname.startsWith("/retry/") || pathname.startsWith("/changes/") || Object.keys(routes).some((k) => k.endsWith(` ${pathname}`));
    res.writeHead(known ? 405 : 404).end(known ? "Method Not Allowed" : "Not Found");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  function closeServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const res of clients) res.end();
      server.closeAllConnections();
    });
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    server,
    close: closeServer,
    setFatal: (f) => {
      fatal = f;
      store.addEvent(`error: ${f.message}`);
    },
  };
}
