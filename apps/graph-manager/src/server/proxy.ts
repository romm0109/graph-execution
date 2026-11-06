import { existsSync } from "node:fs";
import http, { type OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";
import { isRunId, livePage, runDirOf } from "./runs.js";
import { resolveWorkspace } from "./workspaces.js";

const VIEW = /^\/runs\/([^/]+)\/([^/]+)\/view(\/.*)?$/;
/** Never forwarded: the upstream checks Host and Origin itself, and graph-manager's session stays here. */
const DROPPED = new Set(["host", "origin", "referer", "cookie", "connection", "keep-alive", "proxy-connection", "upgrade"]);

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** The upstream port of a run page URL, or undefined unless it is an http URL on 127.0.0.1 or localhost. */
export function upstreamPort(url: string): number | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) return undefined;
  const port = Number(u.port || 80);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/**
 * Serves a live run's own page at `/runs/<ws>/<runId>/view/*` by streaming to and from its local page server.
 * An `onRequest` hook registered after the auth hook: it runs before body parsing, so request bodies stream too.
 */
export async function proxyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    const q = req.url.indexOf("?");
    const pathname = q === -1 ? req.url : req.url.slice(0, q);
    const search = q === -1 ? "" : req.url.slice(q);
    const m = VIEW.exec(pathname);
    if (!m) return;
    const [, wsPart = "", runPart = "", rest] = m;
    if (rest === undefined) return reply.redirect(`${pathname}/${search}`, 302);

    const wsId = decode(wsPart);
    const runId = decode(runPart);
    if (wsId === undefined || runId === undefined || !isRunId(runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = resolveWorkspace(ctx.config.workspacesDir, wsId);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const dir = runDirOf(ws, runId);
    if (!existsSync(dir)) return reply.code(404).send({ error: "unknown run" });
    const web = await livePage(dir);
    const port = web ? upstreamPort(web.url) : undefined;
    if (!web || port === undefined) return reply.code(404).send({ error: "the run's page is not running" });

    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k.toLowerCase())) headers[k] = v;
    headers.host = `127.0.0.1:${port}`;

    reply.hijack();
    const res = reply.raw;
    const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: rest + search, headers }, (up) => {
      const out: OutgoingHttpHeaders = { ...up.headers, "x-accel-buffering": "no" };
      delete out.connection;
      delete out["keep-alive"];
      res.writeHead(up.statusCode ?? 502, out);
      res.flushHeaders();
      up.pipe(res);
      up.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "the run's page did not answer" }));
      } else res.destroy();
    });
    // The browser went away (e.g. an SSE tab closed): drop the upstream request too.
    res.on("close", () => upstream.destroy());
    req.raw.pipe(upstream);
  });
}
