import { createHmac, timingSafeEqual } from "node:crypto";
import "fastify";

/** Who a request acts for. Every authenticated request gets one (`req.user`). */
export interface User {
  id: string;
  name: string;
  email?: string;
}

/** The single user of a graph-manager without accounts: owns the data imported from `graph-manager.json`. */
export const ADMIN_USER: User = { id: "admin", name: "admin" };

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook (auth.ts) before any handler runs. */
    user: User;
  }
}

/** The header the gateway (`GM_AUTH=gateway`) sends with every request: an HS256 JWT signed with `GM_GATEWAY_SECRET`. */
export const IDENTITY_HEADER = "x-gm-identity";
/** The longest accepted token lifetime (`exp - iat`), in seconds. */
export const MAX_IDENTITY_LIFETIME_S = 600;
/** How far the gateway's clock may be off, in seconds. */
export const CLOCK_SKEW_S = 30;

const PART = /^[A-Za-z0-9_-]+$/;

function sign(secret: string, input: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

function decodeJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The user in a valid identity token, else undefined (never throws). Only HS256 with claims `sub` (1–128 chars),
 * `name`, optional `email`, integer `iat`/`exp` (seconds) with a lifetime of 1–600 s, within `CLOCK_SKEW_S`. `now` in ms.
 */
export function verifyIdentity(header: string | undefined, secret: string, now = Date.now()): User | undefined {
  try {
    if (!header || !secret) return undefined;
    const parts = header.split(".");
    if (parts.length !== 3) return undefined;
    const [h = "", p = "", s = ""] = parts;
    if (!PART.test(h) || !PART.test(p) || !PART.test(s)) return undefined;
    const head = decodeJson(h);
    if (!isObject(head) || head.alg !== "HS256") return undefined;
    if (head.typ !== undefined && head.typ !== "JWT") return undefined;
    const expected = sign(secret, `${h}.${p}`);
    const given = Buffer.from(s, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const claims = decodeJson(p);
    if (!isObject(claims)) return undefined;
    const { sub, name, email, iat, exp } = claims;
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) return undefined;
    if (typeof name !== "string") return undefined;
    if (email !== undefined && typeof email !== "string") return undefined;
    if (typeof iat !== "number" || typeof exp !== "number" || !Number.isInteger(iat) || !Number.isInteger(exp)) return undefined;
    const lifetime = exp - iat;
    if (lifetime < 1 || lifetime > MAX_IDENTITY_LIFETIME_S) return undefined;
    const nowS = Math.floor(now / 1000);
    if (iat > nowS + CLOCK_SKEW_S) return undefined;
    if (exp <= nowS - CLOCK_SKEW_S) return undefined;
    return { id: sub, name, ...(email ? { email } : {}) };
  } catch {
    return undefined;
  }
}

/** An identity token for `user`, as the gateway makes them (tests and tools). `now` in ms, `ttl` in seconds. */
export function signIdentity(user: User, secret: string, now = Date.now(), ttl = 300): string {
  const nowS = Math.floor(now / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = { sub: user.id, name: user.name, ...(user.email ? { email: user.email } : {}), iat: nowS, exp: nowS + ttl };
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${sign(secret, `${h}.${p}`).toString("base64url")}`;
}
