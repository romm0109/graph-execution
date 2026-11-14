import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db/db.js";
import type { User } from "./identity.js";

/** A row of the `users` table, in camelCase. */
export interface UserRow {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  createdAt: string;
  disabled: boolean;
}

export const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
export const USERNAME_MESSAGE = "username must be 3–32 characters of a-z, 0-9, _ and -";
export const MIN_PASSWORD = 10;
export const SHORT_PASSWORD_MESSAGE = `password must be at least ${String(MIN_PASSWORD)} characters`;
/** How long a set-password link (invite or reset) works. */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A 4xx answer of the account code: the error handler of app.ts sends `{ error: message }` with `statusCode`. */
export class AccountError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export function validUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

/** `scrypt$N$r$p$<saltBase64url>$<hashBase64url>` with a random 16-byte salt and a 64-byte key. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEY_LEN, SCRYPT);
  return `scrypt$${String(SCRYPT.N)}$${String(SCRYPT.r)}$${String(SCRYPT.p)}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Whether `pw` matches `hash` (constant-time compare); false for a null or malformed hash. */
export async function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  if (hash === null) return false;
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return false;
  const [, n = "", r = "", p = "", salt = "", key = ""] = m;
  const expected = Buffer.from(key, "base64url");
  if (expected.length === 0) return false;
  let given: Buffer;
  try {
    given = await scrypt(pw, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let dummy: Promise<string> | undefined;
/** A fixed hash (computed once) to verify against when a user does not exist, so that costs the same scrypt time. */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}

interface RawRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  created_at: string;
  disabled: number | string | boolean;
}

const COLUMNS = "id, username, display_name, password_hash, created_at, disabled";

function rowOf(r: RawRow): UserRow {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    passwordHash: r.password_hash ?? null,
    createdAt: r.created_at,
    disabled: r.disabled === true || Number(r.disabled) !== 0,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("SQLITE_CONSTRAINT") || code === "23505");
}

async function insertUser(db: Db, row: UserRow): Promise<void> {
  try {
    await db.exec(`INSERT INTO users (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [
      row.id,
      row.username,
      row.displayName,
      row.passwordHash,
      row.createdAt,
      row.disabled ? 1 : 0,
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AccountError(409, "username taken");
    throw err;
  }
}

/** Creates a user (id defaults to the username). Throws `AccountError(409, "username taken")` on a duplicate id or username. */
export async function createUser(
  db: Db,
  p: { id?: string; username: string; displayName: string; passwordHash?: string | null; now?: Date },
): Promise<UserRow> {
  const row: UserRow = {
    id: p.id ?? p.username,
    username: p.username,
    displayName: p.displayName,
    passwordHash: p.passwordHash ?? null,
    createdAt: (p.now ?? new Date()).toISOString(),
    disabled: false,
  };
  await db.transaction(async (tx) => {
    if ((await findUserByUsername(tx, row.username)) || (await getUser(tx, row.id))) throw new AccountError(409, "username taken");
    await insertUser(tx, row);
  });
  return row;
}

export async function findUserByUsername(db: Db, username: string): Promise<UserRow | undefined> {
  const rows = await db.query<RawRow>(`SELECT ${COLUMNS} FROM users WHERE username = ?`, [username]);
  return rows[0] ? rowOf(rows[0]) : undefined;
}

export async function getUser(db: Db, id: string): Promise<UserRow | undefined> {
  const rows = await db.query<RawRow>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]);
  return rows[0] ? rowOf(rows[0]) : undefined;
}

/** All users, oldest first. */
export async function listUsers(db: Db): Promise<UserRow[]> {
  const rows = await db.query<RawRow>(`SELECT ${COLUMNS} FROM users ORDER BY created_at, username`);
  return rows.map(rowOf);
}

export async function countUsers(db: Db): Promise<number> {
  const rows = await db.query<{ n: number | string }>("SELECT COUNT(*) AS n FROM users");
  return Number(rows[0]?.n ?? 0);
}

export async function setPassword(db: Db, id: string, passwordHash: string): Promise<void> {
  await db.exec("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);
}

export async function setDisplayName(db: Db, id: string, name: string): Promise<void> {
  await db.exec("UPDATE users SET display_name = ? WHERE id = ?", [name, id]);
}

export async function disableUser(db: Db, id: string): Promise<void> {
  await db.exec("UPDATE users SET disabled = 1 WHERE id = ?", [id]);
}

/** Deletes the user's row and its set-password links. */
export async function deleteUser(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec("DELETE FROM password_links WHERE user_id = ?", [id]);
    await tx.exec("DELETE FROM users WHERE id = ?", [id]);
  });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A new one-time set-password link token for the user (random 32 bytes, base64url), valid `LINK_TTL_MS`. Only its
 * SHA-256 is stored; the user's earlier unused links stop working.
 */
export async function createPasswordLink(db: Db, userId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.exec("DELETE FROM password_links WHERE user_id = ? AND used_at IS NULL", [userId]);
    await tx.exec("INSERT INTO password_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [
      tokenHash(token),
      userId,
      new Date(now.getTime() + LINK_TTL_MS).toISOString(),
    ]);
  });
  return token;
}

/** The link's user, marking the link used; undefined when the token is unknown, expired or used. */
export async function usePasswordLink(db: Db, token: string, now = new Date()): Promise<UserRow | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ user_id: string; expires_at: string; used_at: string | null }>(
      "SELECT user_id, expires_at, used_at FROM password_links WHERE token_hash = ?",
      [tokenHash(token)],
    );
    const link = rows[0];
    if (!link || link.used_at !== null || Date.parse(link.expires_at) <= now.getTime()) return undefined;
    await tx.exec("UPDATE password_links SET used_at = ? WHERE token_hash = ?", [now.toISOString(), tokenHash(token)]);
    return getUser(tx, link.user_id);
  });
}

export function toUser(row: UserRow): User {
  return { id: row.id, name: row.displayName };
}

/**
 * Makes the install's password the `admin` account's: creates `admin` when there are no users; with the password from
 * `GM_PASSWORD` (or none given, as in tests) sets admin's password to it; with the password file and existing users
 * changes nothing (admin may have changed it in Settings → Account). No minimum length here: `GM_PASSWORD=pw` works.
 */
export async function ensureAdmin(
  db: Db,
  password: string,
  source: "env" | "file" | undefined,
): Promise<{ adminMatches: boolean; users: number }> {
  const create = async (): Promise<void> => {
    await createUser(db, { id: "admin", username: "admin", displayName: "admin", passwordHash: await hashPassword(password) }).catch((err: unknown) => {
      // Another start created it in between.
      if (!(err instanceof AccountError)) throw err;
    });
  };
  let adminMatches: boolean;
  if ((await countUsers(db)) === 0) {
    await create();
    adminMatches = true;
  } else {
    const admin = await getUser(db, "admin");
    adminMatches = await verifyPassword(password, admin?.passwordHash ?? null);
    if (source !== "file" && !adminMatches) {
      if (admin) await setPassword(db, "admin", await hashPassword(password));
      else await create();
      adminMatches = true;
    }
  }
  return { adminMatches, users: await countUsers(db) };
}
