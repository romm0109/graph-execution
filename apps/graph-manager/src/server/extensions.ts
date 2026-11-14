import http, { type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { AppContext } from "./app.js";
import type { Extension } from "./config.js";

const EXT = /^\/ext\/([^/]+)(\/.*)?$/;
/** Never forwarded: graph-manager's session stays here, and the extension headers are always graph-manager's own. */
const DROPPED = new Set(["host", "origin", "referer", "cookie", "connection", "keep-alive", "proxy-connection", "upgrade", "x-gm-extension-secret", "x-gm-user"]);

/** The `ws` client class, reached through a server-side socket so that server code does not import `ws` (bundle-imports.test.ts). */
type WsClientCtor = new (url: string, protocols: string[] | undefined, opts: { headers: Record<string, string> }) => WebSocket;

/** A close code that `ws` accepts in `close()`: 1005/1006 and other reserved codes become 1000. */
const closeCode = (c: number): number => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);

/**
 * A path with a "." or ".." segment, raw or percent-encoded (also with "\\" or %2F/%5C as separators): the upstream
 * would normalize it to a path outside the extension's base path, so it is refused.
 */
export function hasDotSegment(p: string): boolean {
  const plain = p.replace(/%2e/gi, ".").replace(/%2f|%5c|\\/gi, "/");
  return plain.split("/").some((seg) => seg === "." || seg === "..");
}

function find(ctx: AppContext, name: string): Extension | undefined {
  return (ctx.config.extensions ?? []).find((e) => e.name === name);
}

/**
 * The extension slot (`GM_EXTENSIONS`): `GET /api/extensions` lists the names for the nav, and `/ext/<name>/*` is a
 * streamed reverse proxy (HTTP and WebSocket) to the extension's URL that adds `X-GM-Extension-Secret` and `X-GM-User`.
 * The HTTP part is an `onRequest` hook after the auth hook (like the run-page proxy), so bodies stream.
 */
export async function extensionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/extensions", async () => ({ extensions: (ctx.config.extensions ?? []).map((e) => ({ name: e.name })) }));

  app.addHook("onRequest", async (req, reply) => {
    const q = req.url.indexOf("?");
    const pathname = q === -1 ? req.url : req.url.slice(0, q);
    const m = EXT.exec(pathname);
    if (!m) return;
    // WebSocket upgrades go to the route below.
    if (req.headers.upgrade?.toLowerCase() === "websocket") return;
    const search = q === -1 ? "" : req.url.slice(q);
    const [, name = "", rest] = m;
    const ext = find(ctx, name);
    if (!ext) return reply.code(404).send({ error: "unknown extension" });
    if (rest === undefined) return reply.redirect(`${pathname}/${search}`, 302);
    if (hasDotSegment(rest)) return reply.code(400).send({ error: "invalid path" });

    const u = new URL(ext.url);
    const secure = u.protocol === "https:";
    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k.toLowerCase())) headers[k] = v;
    headers.host = u.host;
    headers["x-gm-extension-secret"] = ctx.config.extensionSecret ?? "";
    headers["x-gm-user"] = "admin";
    headers["x-forwarded-prefix"] = `/ext/${name}`;

    reply.hijack();
    const res = reply.raw;
    const request = secure ? https.request : http.request;
    const upstream = request(
      { hostname: u.hostname, port: u.port || (secure ? 443 : 80), method: req.method, path: u.pathname.replace(/\/+$/, "") + rest + search, headers },
      (up) => {
        const out: OutgoingHttpHeaders = { ...up.headers, "x-accel-buffering": "no" };
        delete out.connection;
        delete out["keep-alive"];
        // The browser's cookies are never forwarded (DROPPED), and an upstream cookie must not land on (or replace)
        // graph-manager's own cookies on this origin.
        delete out["set-cookie"];
        res.writeHead(up.statusCode ?? 502, out);
        res.flushHeaders();
        up.pipe(res);
        up.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "the extension did not answer" }));
      } else res.destroy();
    });
    // The browser went away: drop the upstream request too.
    res.on("close", () => upstream.destroy());
    req.raw.pipe(upstream);
  });

  app.get<{ Params: { name: string; "*": string } }>("/ext/:name/*", { websocket: true }, (socket, req) => {
    socket.on("error", () => undefined);
    const name = req.params.name;
    const ext = find(ctx, name);
    if (!ext) {
      socket.close(4404, "unknown extension");
      return;
    }
    const q = req.url.indexOf("?");
    const search = q === -1 ? "" : req.url.slice(q);
    if (hasDotSegment(q === -1 ? req.url : req.url.slice(0, q))) {
      socket.close(4400, "invalid path");
      return;
    }
    const url = `${ext.url.replace(/^http/, "ws")}/${req.params["*"]}${search}`;
    const rawProtocols = req.headers["sec-websocket-protocol"];
    const protocols = rawProtocols
      ? rawProtocols
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "")
      : undefined;
    const Ws = socket.constructor as unknown as WsClientCtor;
    let upstream: WebSocket;
    try {
      upstream = new Ws(url, protocols, {
        headers: { "x-gm-extension-secret": ctx.config.extensionSecret ?? "", "x-gm-user": "admin", "x-forwarded-prefix": `/ext/${name}` },
      });
    } catch {
      socket.close(1011, "the extension did not answer");
      return;
    }

    let open = false;
    let done = false;
    const queue: { data: Parameters<WebSocket["send"]>[0]; binary: boolean }[] = [];
    const failed = () => {
      if (done) return;
      done = true;
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(1011, "the extension did not answer");
      upstream.terminate();
    };

    upstream.on("open", () => {
      open = true;
      for (const m of queue.splice(0)) upstream.send(m.data, { binary: m.binary });
    });
    upstream.on("error", failed);
    upstream.on("unexpected-response", failed);
    upstream.on("message", (data, isBinary) => {
      if (socket.readyState === socket.OPEN) socket.send(data, { binary: isBinary });
    });
    upstream.on("close", (code, reason) => {
      if (done) return;
      done = true;
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(closeCode(code), reason.toString());
    });

    socket.on("message", (data, isBinary) => {
      if (open) {
        if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
      } else queue.push({ data, binary: isBinary });
    });
    socket.on("close", (code, reason) => {
      if (done) return;
      done = true;
      if (upstream.readyState === upstream.OPEN) upstream.close(closeCode(code), reason.toString());
      else upstream.terminate();
    });
  });
}
