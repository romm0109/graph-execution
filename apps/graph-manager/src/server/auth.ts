import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { findToken, type ApiScope } from "./tokens.js";

export const SESSION_COOKIE = "gm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_OPTIONS = { httpOnly: true, sameSite: "strict", path: "/" } as const;

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** A session cookie value: `<expiresMs>.<nonceHex>.<hmacSha256Hex(secret, "<expiresMs>.<nonceHex>")>`. */
export function signSession(secret: string, now = Date.now(), nonce = randomBytes(16).toString("hex")): string {
  const payload = `${String(now + SESSION_TTL_MS)}.${nonce}`;
  return `${payload}.${hmac(secret, payload)}`;
}

export interface Session {
  expires: number;
  nonce: string;
}

/** The session in the cookie when it carries a valid signature and has not expired; revocation is checked by the caller. */
export function parseSession(cookie: string | undefined, secret: string, now = Date.now()): Session | undefined {
  if (!cookie) return undefined;
  const match = /^(\d{1,16})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(cookie);
  if (!match) return undefined;
  const [, expires = "", nonce = "", sig = ""] = match;
  const expected = Buffer.from(hmac(secret, `${expires}.${nonce}`), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  if (Number(expires) <= now) return undefined;
  return { expires: Number(expires), nonce };
}

/** True when the cookie carries a valid signature and has not expired. */
export function verifySession(cookie: string | undefined, secret: string, now = Date.now()): boolean {
  return parseSession(cookie, secret, now) !== undefined;
}

/** Compares two passwords in constant time (over their SHA-256 digests, so lengths don't leak). */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const RUN_VIEW = /^\/runs\/[^/]+\/[^/]+\/view(\/.*)?$/;

/**
 * Whether a request needs a session: every `/api/*` URL except the login (POST), the login page's info (GET) and the
 * terminals' `/api/internal/*` (bearer token), and the
 * run-page proxy `/runs/<ws>/<runId>/view[/*]`, and the extension proxy `/ext/<name>/*`. A request to `/api/v1[/*]`
 * with an `Authorization: Bearer` API token is checked by the token branch of the auth hook before this applies (it then
 * needs no session).
 */
export function needsAuth(method: string, url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  if (pathname === "/api/auth/login" && method.toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/info" && method.toUpperCase() === "GET") return false;
  // The terminals' internal API checks its own bearer token (KAN-88).
  if (pathname.startsWith("/api/internal/")) return false;
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;
  if (pathname === "/ext" || pathname.startsWith("/ext/")) return true;
  return RUN_VIEW.test(pathname);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function firstHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(",", 1)[0]?.trim() || undefined;
}

/**
 * Whether a request must come from graph-manager's own page: every WebSocket upgrade and every state-changing request
 * (not GET/HEAD/OPTIONS) to `/api/*`, the run-page proxy or the extension proxy `/ext/<name>/*`. SameSite cookies do not
 * separate ports on one host. A bearer-token request to `/api/v1[/*]` skips this check (a token is not ambient like a
 * cookie, so no CSRF).
 */
export function needsSameOrigin(method: string, url: string, upgrade: string | undefined): boolean {
  if (upgrade?.toLowerCase() === "websocket") return true;
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  return pathname === "/api" || pathname.startsWith("/api/") || RUN_VIEW.test(pathname) || pathname === "/ext" || pathname.startsWith("/ext/");
}

/**
 * True when the request has no Origin (not a browser, or a same-origin GET) or its Origin's host:port is the Host the
 * request was sent to (or the X-Forwarded-Host a reverse proxy set; a page cannot set that header on a WebSocket or
 * without a CORS preflight, which this server never allows).
 */
export function originAllowed(req: Pick<FastifyRequest, "headers">): boolean {
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [firstHeader(req.headers.host), firstHeader(req.headers["x-forwarded-host"])].filter((h): h is string => !!h);
  return hosts.some((h) => h.toLowerCase() === host);
}

/** Who called a /api/v1 route: the cookie session (every scope) or an API token. */
export type ApiAuth = { kind: "admin" } | { kind: "token"; id: string; scopes: ApiScope[] };

const apiAuth = new WeakMap<FastifyRequest, ApiAuth>();

/** Who called a /api/v1 route: the cookie session (every scope) or a token. Undefined outside /api/v1. */
export function apiAuthOf(req: FastifyRequest): ApiAuth | undefined {
  return apiAuth.get(req);
}

/** preHandler: 403 `missing scope <scope>` unless the caller has it (a cookie session has every scope). */
export function requireScope(scope: ApiScope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const a = apiAuth.get(req);
    if (a?.kind === "token" && !a.scopes.includes(scope)) {
      await reply.code(403).send({ error: `missing scope ${scope}` });
    }
  };
}

/** The credential of an `Authorization: Bearer <x>` header (the scheme is case-insensitive); undefined for any other header. */
export function bearerOf(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^Bearer +(.*)$/i.exec(header.trim());
  return match ? (match[1] ?? "") : undefined;
}

/** How often a token's `lastUsedAt` is written at most. */
export const TOKEN_TOUCH_MS = 60_000;

/** Failed logins allowed per client IP within `LOGIN_WINDOW_MS` before it gets 429. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const loginBody = z.object({ password: z.string() });

/** The session hook (for HTTP and WebSocket upgrades alike) and the login/logout/me/info routes. */
export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const session = (req: FastifyRequest): Session | undefined => {
    const data = ctx.store.get();
    const s = parseSession(req.cookies[SESSION_COOKIE], data.sessionSecret);
    return s && data.revokedSessions[s.nonce] === undefined ? s : undefined;
  };

  // The last lastUsedAt write per token id (ms), so parallel requests within the minute don't each queue a write.
  const touched = new Map<string, number>();
  const touch = (id: string, lastUsedAt: string | undefined): void => {
    const now = Date.now();
    const last = Math.max(touched.get(id) ?? 0, lastUsedAt ? Date.parse(lastUsedAt) || 0 : 0);
    if (now - last < TOKEN_TOUCH_MS) return;
    touched.set(id, now);
    void ctx.store
      .update((d) => {
        const t = d.apiTokens[id];
        if (t) t.lastUsedAt = new Date(now).toISOString();
      })
      .catch(() => undefined);
  };

  app.addHook("onRequest", async (req, reply) => {
    const pathname = req.url.split(/[?#]/, 1)[0] ?? "";
    const v1 = pathname === "/api/v1" || pathname.startsWith("/api/v1/");
    // A bearer API token on /api/v1 replaces the cookie and skips the Origin check; elsewhere the header is ignored.
    const bearer = v1 ? bearerOf(req.headers.authorization) : undefined;
    if (bearer !== undefined) {
      const data = ctx.store.get();
      const id = findToken(data.apiTokens, bearer);
      const tok = id === undefined ? undefined : data.apiTokens[id];
      if (id === undefined || !tok) return reply.code(401).send({ error: "invalid token" });
      apiAuth.set(req, { kind: "token", id, scopes: [...tok.scopes] });
      touch(id, tok.lastUsedAt);
      return;
    }
    if (needsSameOrigin(req.method, req.url, req.headers.upgrade) && !originAllowed(req)) {
      return reply.code(403).send({ error: "cross-origin request refused" });
    }
    if (!needsAuth(req.method, req.url)) return;
    if (session(req)) {
      if (v1) apiAuth.set(req, { kind: "admin" });
      return;
    }
    return reply.code(401).send({ error: "login required" });
  });

  // Per-IP failed logins: after LOGIN_MAX_FAILURES within the window, every attempt answers 429 until it ends.
  const failures = new Map<string, { count: number; since: number }>();
  app.post("/api/auth/login", async (req, reply) => {
    const now = Date.now();
    for (const [ip, f] of failures) if (now - f.since >= LOGIN_WINDOW_MS) failures.delete(ip);
    const seen = failures.get(req.ip);
    if (seen && seen.count >= LOGIN_MAX_FAILURES) {
      const retry = Math.ceil((seen.since + LOGIN_WINDOW_MS - now) / 1000);
      return reply.code(429).header("retry-after", String(retry)).send({ error: "too many failed logins; try again later" });
    }
    const { password } = loginBody.parse(req.body ?? {});
    if (!passwordMatches(password, ctx.config.password)) {
      failures.set(req.ip, { count: (seen?.count ?? 0) + 1, since: seen?.since ?? now });
      return reply.code(401).send({ error: "wrong password" });
    }
    failures.delete(req.ip);
    reply.setCookie(SESSION_COOKIE, signSession(ctx.store.get().sessionSecret), {
      ...COOKIE_OPTIONS,
      maxAge: SESSION_TTL_MS / 1000,
    });
    return reply.code(204).send();
  });

  // Revokes the session on the server too, so a copied cookie stops working. Expired entries are pruned here.
  app.post("/api/auth/logout", async (req, reply) => {
    const s = session(req);
    if (s) {
      const now = Date.now();
      await ctx.store.update((d) => {
        for (const [nonce, expires] of Object.entries(d.revokedSessions)) if (expires <= now) delete d.revokedSessions[nonce];
        d.revokedSessions[s.nonce] = s.expires;
      });
    }
    reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async () => ({ ok: true }));

  // Public: the login page shows which host it logs in to.
  app.get("/api/auth/info", async () => ({ host: os.hostname() }));
}
