import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The scopes an API token can carry (docs/prd/automation-api.md). */
export const API_SCOPES = ["runs:start", "runs:read", "runs:approve", "runs:control", "runs:pr", "workspaces:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** A stored token as the API shows it: never the hash. */
export interface PublicToken {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt?: string;
  createdBy: "admin";
}

/** A new plain token: `gmt_` + 32 random bytes as base64url. Shown once, then only its hash is kept. */
export const newToken = (): string => `gmt_${randomBytes(32).toString("base64url")}`;

/** A new token id: 8 random bytes as hex. */
export const newTokenId = (): string => randomBytes(8).toString("hex");

/** The SHA-256 hex of a token: what the store keeps. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The id of the stored token whose hash matches, compared in constant time over every entry (no early exit). */
export function findToken(tokens: Record<string, { hash: string }>, token: string): string | undefined {
  const given = Buffer.from(hashToken(token), "hex");
  let found: string | undefined;
  for (const [id, t] of Object.entries(tokens)) {
    const stored = Buffer.from(t.hash, "hex");
    if (stored.length === given.length && timingSafeEqual(stored, given) && found === undefined) found = id;
  }
  return found;
}

/** The public view of a stored token (no hash). */
export function publicToken(
  id: string,
  t: { name: string; scopes: ApiScope[]; createdAt: string; lastUsedAt?: string; createdBy: "admin" },
): PublicToken {
  return {
    id,
    name: t.name,
    scopes: [...t.scopes],
    createdAt: t.createdAt,
    ...(t.lastUsedAt !== undefined ? { lastUsedAt: t.lastUsedAt } : {}),
    createdBy: t.createdBy,
  };
}
