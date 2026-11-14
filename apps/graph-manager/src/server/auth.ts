import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccountError, createUser, dummyHash, findUserByUsername, getUser, setDisplayName, toUser, verifyPassword, type UserRow } from "./accounts.js";
import type { AppContext } from "./app.js";
import type { Db } from "./db/db.js";
import { ADMIN_USER, IDENTITY_HEADER, type User, verifyIdentity } from "./identity.js";

export const SESSION_COOKIE = "gm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_OPTIONS = { httpOnly: true, sameSite: "strict", path: "/" } as const;

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * A session cookie value: `<expiresMs>.<nonceHex>.<userId>.<hmacSha256Hex(secret, "<expiresMs>.<nonceHex>.<userId>")>`.
 * `now` is when it is issued (its expiry minus `SESSION_TTL_MS`).
 */
export function signSession(secret: string, userId: string, now = Date.now(), nonce = randomBytes(16).toString("hex")): string {
  const payload = `${String(now + SESSION_TTL_MS)}.${nonce}.${userId}`;
  return `${payload}.${hmac(secret, payload)}`;
}

export interface Session {
  expires: number;
  nonce: string;
  userId: string;
}

/**
 * The session in the cookie when it carries a valid signature and has not expired; the user and revocation are checked
 * by the caller. A cookie of the old 3-part format (before accounts) is rejected: log in again.
 */
export function parseSession(cookie: string | undefined, secret: string, now = Date.now()): Session | undefined {
  if (!cookie) return undefined;
  const match = /^(\d{1,16})\.([0-9a-f]{32})\.([a-z0-9_-]{1,64})\.([0-9a-f]{64})$/.exec(cookie);
  if (!match) return undefined;
  const [, expires = "", nonce = "", userId = "", sig = ""] = match;
  const expected = Buffer.from(hmac(secret, `${expires}.${nonce}.${userId}`), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  if (Number(expires) <= now) return undefined;
  return { expires: Number(expires), nonce, userId };
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
 * Whether a request needs a session: every `/api/*` URL except the login, sign-up and set-password (POST), the login
 * page's info (GET), the terminals' `/api/internal/*` and the gateway's `/api/gateway/*` (bearer tokens), and the
 * run-page proxy `/runs/<ws>/<runId>/view[/*]`.
 */
export function needsAuth(method: string, url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  if (pathname === "/api/auth/login" && method.toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/info" && method.toUpperCase() === "GET") return false;
  // Accounts (routes/accounts.ts): open sign-up and the one-time set-password links.
  if ((pathname === "/api/auth/signup" || pathname === "/api/auth/set-password") && method.toUpperCase() === "POST") return false;
  // The terminals' internal API checks its own bearer token (KAN-88).
  if (pathname.startsWith("/api/internal/")) return false;
  // The gateway's user management (routes/gateway.ts) checks GM_GATEWAY_SECRET as a bearer token.
  if (pathname.startsWith("/api/gateway/")) return false;
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;
  return RUN_VIEW.test(pathname);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function firstHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(",", 1)[0]?.trim() || undefined;
}

/**
 * Whether a request must come from graph-manager's own page: every WebSocket upgrade and every state-changing request
 * (not GET/HEAD/OPTIONS) to `/api/*` or the run-page proxy. SameSite cookies do not separate ports on one host.
 */
export function needsSameOrigin(method: string, url: string, upgrade: string | undefined): boolean {
  if (upgrade?.toLowerCase() === "websocket") return true;
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  return pathname === "/api" || pathname.startsWith("/api/") || RUN_VIEW.test(pathname);
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

/** Failed logins allowed per client IP, and per username, within `LOGIN_WINDOW_MS` before it gets 429. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** A missing username means `admin`: clients of the single-password era send `{ password }` only. */
const loginBody = z.object({ username: z.string().optional(), password: z.string() });

/** Sets the session cookie of `userId`, issued at `now`. */
export function issueSession(reply: FastifyReply, ctx: AppContext, userId: string, now = Date.now()): void {
  reply.setCookie(SESSION_COOKIE, signSession(ctx.store.instance().sessionSecret, userId, now), {
    ...COOKIE_OPTIONS,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/** A 4xx answer of `resolveGatewayUser`. */
export class GatewayUserError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayUserError";
  }
}

export const MIXED_ACCOUNT_MESSAGE = "this account uses built-in sign-in; gateway and built-in accounts cannot be mixed";
export const NOT_IN_GATEWAY_MODE = "not available in gateway mode";

/**
 * The user of a verified gateway identity: creates its `users` row on the first request of a new `sub` and keeps its
 * display name current. Throws `GatewayUserError(403)` for a built-in account (one with a password) or a disabled one.
 */
export async function resolveGatewayUser(db: Db, identity: User): Promise<User> {
  let row: UserRow | undefined = await getUser(db, identity.id);
  if (!row) {
    try {
      row = await createUser(db, { id: identity.id, username: identity.id, displayName: identity.name, passwordHash: null });
    } catch (err) {
      // A concurrent first request created it.
      if (!(err instanceof AccountError) || err.statusCode !== 409) throw err;
      row = await getUser(db, identity.id);
      // The username is another account's id: a built-in account.
      if (!row) throw new GatewayUserError(403, MIXED_ACCOUNT_MESSAGE);
    }
  }
  if (row.passwordHash !== null) throw new GatewayUserError(403, MIXED_ACCOUNT_MESSAGE);
  if (row.disabled) throw new GatewayUserError(403, "account disabled");
  if (row.displayName !== identity.name) await setDisplayName(db, row.id, identity.name);
  return { id: row.id, name: identity.name, ...(identity.email ? { email: identity.email } : {}) };
}

type Failures = Map<string, { count: number; since: number }>;

/** The session hook (for HTTP and WebSocket upgrades alike) and the login/logout/me/info routes. */
export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** The cookie's session and user, unless the user is missing or disabled or the session was revoked. */
  const session = async (req: FastifyRequest): Promise<{ s: Session; user: User } | undefined> => {
    const s = parseSession(req.cookies[SESSION_COOKIE], ctx.store.instance().sessionSecret);
    if (!s) return undefined;
    const row = await getUser(ctx.db, s.userId);
    if (!row || row.disabled) return undefined;
    const user = toUser(row);
    const d = (await ctx.store.forUser(user)).get();
    if (d.revokedSessions[s.nonce] !== undefined) return undefined;
    if (s.expires - SESSION_TTL_MS < (d.sessionsValidAfter ?? 0)) return undefined;
    return { s, user };
  };

  app.decorateRequest("user", null as unknown as User);

  app.addHook("onRequest", async (req, reply) => {
    if (needsSameOrigin(req.method, req.url, req.headers.upgrade) && !originAllowed(req)) {
      return reply.code(403).send({ error: "cross-origin request refused" });
    }
    if (!needsAuth(req.method, req.url)) {
      // So that `req.user` is never null in a handler.
      req.user = ADMIN_USER;
      return;
    }
    if (ctx.config.auth === "gateway") {
      // The gateway signed the user in; session cookies are never read in this mode.
      const raw = req.headers[IDENTITY_HEADER];
      const identity = verifyIdentity(Array.isArray(raw) ? raw[0] : raw, ctx.config.gatewaySecret ?? "");
      if (!identity) return reply.code(401).send({ error: "gateway identity required" });
      try {
        req.user = await resolveGatewayUser(ctx.db, identity);
      } catch (err) {
        if (err instanceof GatewayUserError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
      return;
    }
    const found = await session(req);
    if (found) {
      req.user = found.user;
      return;
    }
    return reply.code(401).send({ error: "login required" });
  });

  // Failed logins per IP and per username: after LOGIN_MAX_FAILURES within the window, every attempt answers 429 until it ends.
  const byIp: Failures = new Map();
  const byUser: Failures = new Map();
  const prune = (m: Failures, now: number): void => {
    for (const [k, f] of m) if (now - f.since >= LOGIN_WINDOW_MS) m.delete(k);
  };
  const retryAfter = (f: { count: number; since: number } | undefined, now: number): number | undefined =>
    f && f.count >= LOGIN_MAX_FAILURES ? Math.ceil((f.since + LOGIN_WINDOW_MS - now) / 1000) : undefined;
  const fail = (m: Failures, key: string, now: number): void => {
    const seen = m.get(key);
    m.set(key, { count: (seen?.count ?? 0) + 1, since: seen?.since ?? now });
  };

  app.post("/api/auth/login", async (req, reply) => {
    if (ctx.config.auth === "gateway") return reply.code(404).send({ error: NOT_IN_GATEWAY_MODE });
    const now = Date.now();
    prune(byIp, now);
    prune(byUser, now);
    const body = loginBody.parse(req.body ?? {});
    const username = (body.username ?? "admin").trim().toLowerCase();
    const waits = [retryAfter(byIp.get(req.ip), now), retryAfter(byUser.get(username), now)].filter((w): w is number => w !== undefined);
    if (waits.length > 0) {
      return reply
        .code(429)
        .header("retry-after", String(Math.max(...waits)))
        .send({ error: "too many failed logins; try again later" });
    }
    const row = await findUserByUsername(ctx.db, username);
    // An unknown user costs the same scrypt time as a known one.
    const ok = await verifyPassword(body.password, row ? row.passwordHash : await dummyHash());
    if (!row || !ok) {
      fail(byIp, req.ip, now);
      fail(byUser, username, now);
      return reply.code(401).send({ error: "wrong username or password" });
    }
    if (row.disabled) return reply.code(403).send({ error: "account disabled" });
    byIp.delete(req.ip);
    issueSession(reply, ctx, row.id);
    return reply.code(204).send();
  });

  // Revokes the session on the server too, so a copied cookie stops working. Expired entries are pruned here.
  app.post("/api/auth/logout", async (req, reply) => {
    if (ctx.config.auth === "gateway") return reply.code(404).send({ error: NOT_IN_GATEWAY_MODE });
    const found = await session(req);
    if (found) {
      const { s } = found;
      const now = Date.now();
      await (await ctx.store.forUser(req.user)).update((d) => {
        for (const [nonce, expires] of Object.entries(d.revokedSessions)) if (expires <= now) delete d.revokedSessions[nonce];
        d.revokedSessions[s.nonce] = s.expires;
      });
    }
    reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req) => {
    const mode = ctx.config.auth;
    const user: User = { id: req.user.id, name: req.user.name, ...(req.user.email ? { email: req.user.email } : {}) };
    const logoutUrl = mode === "gateway" ? ctx.config.gatewayLogoutUrl : undefined;
    return { user, mode, ...(logoutUrl ? { logoutUrl } : {}) };
  });

  // Public: the login page shows which host it logs in to, how users sign in, and whether it offers sign-up.
  app.get("/api/auth/info", async () => ({
    host: os.hostname(),
    mode: ctx.config.auth,
    signup: ctx.config.auth !== "gateway" && ctx.config.signup === "open",
  }));
}
