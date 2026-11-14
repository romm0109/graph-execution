import { existsSync } from "node:fs";
import http, { type OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./app.js";
import { RemoteWorkspaceHost } from "./host/remote.js";
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
    if (!(await ctx.sessions.ownsWorkspace(req.user, wsId))) return reply.code(404).send({ error: "unknown workspace" });
    // A live hosted run: its page is served by the workspace agent of its run container.
    const runHost = ctx.hostedRuns.hostOf(req.user, wsId, runId);
    if (runHost instanceof RemoteWorkspaceHost) {
      const t = runHost.viewTarget(wsId, runId);
      const u = new URL(t.url);
      pipeToUpstream(req, reply, { host: u.hostname, port: Number(u.port || 80), hostHeader: u.host, extraHeaders: t.headers }, `${u.pathname}${rest}${search}`);
      return;
    }
    const home = resolveRunHome(ctx.config.workspacesDir, await ctx.store.forUser(req.user), wsId);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    const dir = runDirOf(home, runId);
    if (!existsSync(dir)) return reply.code(404).send({ error: "unknown run" });
    const web = await livePage(dir);
    const port = web ? upstreamPort(web.url) : undefined;
    // A sandboxed run: its container's address on gm-sandbox; else the local page server.
    const target = web?.upstream ?? (port !== undefined ? { host: "127.0.0.1", port } : undefined);
    if (!target) return reply.code(404).send({ error: "the run's page is not running" });

    // The engine's Host check accepts only 127.0.0.1:<its own port>, wherever it runs.
    const hostHeader = `127.0.0.1:${"hostPort" in target && target.hostPort ? target.hostPort : target.port}`;
    // A sandboxed run's page secret (KAN-88 F1); a browser-sent one is dropped by pipeToUpstream.
    const extraHeaders: OutgoingHttpHeaders = "token" in target && target.token ? { [WEB_TOKEN_HEADER]: target.token } : {};
    pipeToUpstream(req, reply, { host: target.host, port: target.port, hostHeader, extraHeaders }, rest + search);
  });
}

/**
 * Streams `req` to a run page at `target` (`pathAndSearch` on it) and its answer back, SSE included: hijacks the
 * reply. Drops the headers in DROPPED (plus `dropHeaders`), sets `Host: hostHeader`, then adds `extraHeaders`.
 */
export function pipeToUpstream(
  req: FastifyRequest,
  reply: FastifyReply,
  target: { host: string; port: number; hostHeader: string; extraHeaders?: OutgoingHttpHeaders; dropHeaders?: string[] },
  pathAndSearch: string,
): void {
  const drop = new Set([...DROPPED, ...(target.dropHeaders ?? []).map((h) => h.toLowerCase())]);
  const headers: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !drop.has(k.toLowerCase())) headers[k] = v;
  headers.host = target.hostHeader;
  Object.assign(headers, target.extraHeaders ?? {});

  reply.hijack();
  const res = reply.raw;
  const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: pathAndSearch, headers }, (up) => {
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
}
