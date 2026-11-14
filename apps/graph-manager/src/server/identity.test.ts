import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signIdentity, verifyIdentity } from "./identity.js";

const SECRET = "k".repeat(32);
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;

const b64 = (v: unknown): string => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** A token signed by hand: `alg` picks the HMAC (`HS256`/`HS512`), `sig` overrides the signature. */
function token(header: unknown, claims: unknown, opts: { hash?: string; sig?: string; secret?: string } = {}): string {
  const h = b64(header);
  const p = b64(claims);
  const sig = opts.sig ?? createHmac(opts.hash ?? "sha256", opts.secret ?? SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ sub: "u1", name: "Uma", iat: NOW_S, exp: NOW_S + 300, ...extra });
const HS256 = { alg: "HS256", typ: "JWT" };

describe("verifyIdentity", () => {
  it("accepts a token from signIdentity", () => {
    expect(verifyIdentity(signIdentity({ id: "u1", name: "Uma", email: "u@x.io" }, SECRET, NOW), SECRET, NOW)).toEqual({
      id: "u1",
      name: "Uma",
      email: "u@x.io",
    });
    expect(verifyIdentity(signIdentity({ id: "u1", name: "Uma" }, SECRET, NOW), SECRET, NOW)).toEqual({ id: "u1", name: "Uma" });
    expect(verifyIdentity(token({ alg: "HS256" }, claims()), SECRET, NOW)).toEqual({ id: "u1", name: "Uma" });
  });

  it("rejects a wrong signature", () => {
    expect(verifyIdentity(signIdentity({ id: "u1", name: "Uma" }, "o".repeat(32), NOW), SECRET, NOW)).toBeUndefined();
    const t = signIdentity({ id: "u1", name: "Uma" }, SECRET, NOW);
    const last = t.at(-2) === "A" ? "B" : "A";
    const changed = `${t.slice(0, -2)}${last}${t.slice(-1)}`;
    expect(changed).not.toBe(t);
    expect(verifyIdentity(changed, SECRET, NOW)).toBeUndefined();
  });

  it("rejects alg none and HS512", () => {
    expect(verifyIdentity(token({ alg: "none" }, claims(), { sig: "" }), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token({ alg: "none" }, claims(), { sig: "abc" }), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token({ alg: "HS512", typ: "JWT" }, claims(), { hash: "sha512" }), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token({ alg: "HS256", typ: "JOSE" }, claims()), SECRET, NOW)).toBeUndefined();
  });

  it("checks the expiry with 30 s of skew", () => {
    const t = token(HS256, claims());
    expect(verifyIdentity(t, SECRET, NOW + (300 + 29) * 1000)).toBeDefined();
    expect(verifyIdentity(t, SECRET, NOW + (300 + 30) * 1000)).toBeUndefined();
    expect(verifyIdentity(t, SECRET, NOW + (300 + 31) * 1000)).toBeUndefined();
  });

  it("rejects an iat more than 30 s in the future", () => {
    expect(verifyIdentity(token(HS256, claims({ iat: NOW_S + 30, exp: NOW_S + 330 })), SECRET, NOW)).toBeDefined();
    expect(verifyIdentity(token(HS256, claims({ iat: NOW_S + 31, exp: NOW_S + 331 })), SECRET, NOW)).toBeUndefined();
  });

  it("rejects a lifetime over 600 s or under 1 s", () => {
    expect(verifyIdentity(token(HS256, claims({ exp: NOW_S + 600 })), SECRET, NOW)).toBeDefined();
    expect(verifyIdentity(token(HS256, claims({ exp: NOW_S + 601 })), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token(HS256, claims({ exp: NOW_S })), SECRET, NOW)).toBeUndefined();
  });

  it("requires sub, name, iat and exp", () => {
    for (const key of ["sub", "name", "iat", "exp"]) {
      const c = claims();
      delete c[key];
      expect(verifyIdentity(token(HS256, c), SECRET, NOW), key).toBeUndefined();
    }
    expect(verifyIdentity(token(HS256, claims({ sub: "" })), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token(HS256, claims({ sub: "x".repeat(129) })), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token(HS256, claims({ iat: NOW_S + 0.5 })), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token(HS256, claims({ email: 5 })), SECRET, NOW)).toBeUndefined();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [undefined, "", "a.b", "a.b.c.d", "a..c", "a+b.c.d", "a.b.c"]) {
      expect(verifyIdentity(bad, SECRET, NOW), String(bad)).toBeUndefined();
    }
    expect(verifyIdentity(token(HS256, "not json"), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token(HS256, [1, 2]), SECRET, NOW)).toBeUndefined();
    expect(verifyIdentity(token("{", claims()), SECRET, NOW)).toBeUndefined();
  });
});
