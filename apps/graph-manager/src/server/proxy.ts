import { existsSync } from "node:fs";
import http, { type OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";
import { isRunId, livePage, runDirOf } from "./runs.js";
import { resolveRunHome } from "./runhome.js";

/** The header that carries a sandboxed run's page secret (the engine's WEB_TOKEN_HEADER). */
export const WEB_TOKEN_HEADER = "x-graph-execution-token";

const VIEW = /^\/runs\/([^/]+)\/([^/]+)\/view(\/.*)?$/;
/** Never forwarded: the upstream checks Host and Origin itself, and graph-manager's session stays here. */
const DROPPED = new Set(["host", "origin", "referer", "cookie", "connection", "keep-alive", "proxy-connection", "upgrade", WEB_TOKEN_HEADER]);

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

/** GETs JSON from a run page at `target` with `Host: 127.0.0.1:<port>` (fetch cannot set Host). Rejects on non-200 or timeout. */
export function upstreamGetJson(
  target: { host: string; port: number; hostPort?: number; token?: string },
  pathname: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { host: `127.0.0.1:${target.hostPort ?? target.port}`, accept: "application/json" };
    if (target.token) headers[WEB_TOKEN_HEADER] = target.token;
    const req = http.request(
      { host: target.host, port: target.port, method: "GET", path: pathname, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`${pathname} answered ${String(res.statusCode)}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${pathname} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** Where a run page answers: a sandboxed run's container on gm-sandbox, or a local page server. */
export type PageTarget = { host: string; port: number; hostPort?: number; token?: string };

/** The page target of a live run, or undefined when the run has no live page. */
export async function pageTargetOf(runDir: string): Promise<PageTarget | undefined> {
  const web = await livePage(runDir);
  const port = web ? upstreamPort(web.url) : undefined;
  // A sandboxed run: its container's address on gm-sandbox; else the local page server.
  return web?.upstream ?? (port !== undefined ? { host: "127.0.0.1", port } : undefined);
}

/**
 * POSTs an empty body to a run page at `target` (same Host and token headers as upstreamGetJson). Resolves with any
 * status and the parsed JSON body (undefined when it is not JSON); rejects on a network error or timeout.
 */
export function upstreamPost(target: PageTarget, pathname: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      host: `127.0.0.1:${target.hostPort ?? target.port}`,
      accept: "application/json",
      "content-length": 0,
    };
    if (target.token) headers[WEB_TOKEN_HEADER] = target.token;
    const req = http.request({ host: target.host, port: target.port, method: "POST", path: pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${pathname} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
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
    const home = resolveRunHome(ctx.config.workspacesDir, ctx.store, wsId);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    const dir = runDirOf(home, runId);
    if (!existsSync(dir)) return reply.code(404).send({ error: "unknown run" });
    const target = await pageTargetOf(dir);
    if (!target) return reply.code(404).send({ error: "the run's page is not running" });

    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k.toLowerCase())) headers[k] = v;
    // The engine's Host check accepts only 127.0.0.1:<its own port>, wherever it runs.
    headers.host = `127.0.0.1:${target.hostPort ?? target.port}`;
    // A sandboxed run's page secret (KAN-88 F1); a browser-sent one is dropped above.
    if (target.token) headers[WEB_TOKEN_HEADER] = target.token;

    reply.hijack();
    const res = reply.raw;
    const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: rest + search, headers }, (up) => {
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
