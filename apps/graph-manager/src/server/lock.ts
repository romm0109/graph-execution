import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { renameReplacing } from "graph-execution/api";
import { z } from "zod";

/** The file in the data dir that says which graph-manager server runs on it. */
export const LOCK_FILE = "server.lock";

export interface ServerLock {
  pid: number;
  port: number;
  host: string;
  /** `https` when the server serves TLS (`GM_TLS_CERT`/`GM_TLS_KEY`); a lock without it is `http`. */
  scheme?: "http" | "https";
  startedAt: string;
}

export interface FindOptions {
  /** Default: process.kill(pid, 0) succeeds or throws EPERM → alive; ESRCH or anything else → dead. */
  isAlive?: (pid: number) => boolean;
  /** Default: GET <scheme>://<host>:<port>/api/auth/info with a 2 s timeout → true on 200 with JSON { host: string }. */
  answers?: (host: string, port: number, scheme: "http" | "https") => Promise<boolean>;
}

const lockSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: z.string(),
  scheme: z.enum(["http", "https"]).optional(),
  startedAt: z.string(),
});

const lockFile = (dataDir: string): string => path.join(dataDir, LOCK_FILE);

/** Whether a process with this pid exists. EPERM: it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The address to connect to for a listening host: a wildcard becomes loopback (same mapping as `browserUrl`). */
function connectHost(host: string): string {
  let h = host;
  if (h === "0.0.0.0") h = "127.0.0.1";
  else if (h === "::" || h === "[::]") h = "::1";
  if (h.includes(":") && !h.startsWith("[")) h = `[${h}]`;
  return h;
}

const isAuthInfo = (body: unknown): boolean =>
  typeof body === "object" && body !== null && typeof (body as { host?: unknown }).host === "string";

/** GET over HTTPS without checking the certificate: the server is ours, on this machine, and often self-signed. */
function getHttpsJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as unknown });
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Whether a graph-manager answers on this address: its public `GET /api/auth/info` returns `{ host }`. */
export async function answersAuthInfo(host: string, port: number, scheme: "http" | "https" = "http"): Promise<boolean> {
  const url = `${scheme}://${connectHost(host)}:${port}/api/auth/info`;
  try {
    if (scheme === "https") {
      const res = await getHttpsJson(url, 2000);
      return res.status === 200 && isAuthInfo(res.body);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.status !== 200) return false;
    return isAuthInfo((await res.json()) as unknown);
  } catch {
    return false;
  }
}

async function readLock(dataDir: string): Promise<ServerLock | null> {
  let raw: string;
  try {
    raw = await readFile(lockFile(dataDir), "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = lockSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The running server on this data folder, or null: no file or an invalid one, this process's own pid, a dead pid,
 * or a port that does not answer as graph-manager (pids are reused, so a live pid alone proves nothing).
 */
export async function findRunning(dataDir: string, opts: FindOptions = {}): Promise<ServerLock | null> {
  const lock = await readLock(dataDir);
  if (!lock || lock.pid === process.pid) return null;
  if (!(opts.isAlive ?? pidAlive)(lock.pid)) return null;
  if (!(await (opts.answers ?? answersAuthInfo)(lock.host, lock.port, lock.scheme ?? "http"))) return null;
  return lock;
}

/** Writes the lock atomically, mode 0o600. */
export async function writeLock(dataDir: string, lock: ServerLock): Promise<void> {
  const file = lockFile(dataDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await renameReplacing(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Deletes the lock only when it is this process's. Never throws. */
export async function removeLock(dataDir: string): Promise<void> {
  try {
    const lock = await readLock(dataDir);
    if (lock?.pid === process.pid) await rm(lockFile(dataDir), { force: true });
  } catch {
    // best-effort: a stale lock never blocks a start
  }
}

/** Held from the lock check until `server.lock` is written, so two servers that start at once can't both pass it. */
export const START_FILE = "server.lock.starting";

export interface StartLockOptions {
  isAlive?: (pid: number) => boolean;
  /** How long to wait for another starting server before taking over its start file. Default 30 s. */
  waitMs?: number;
  /** Poll interval. Default 100 ms. */
  pollMs?: number;
}

/**
 * Creates `<dataDir>/server.lock.starting` exclusively and returns its release function. While another live process
 * holds it, waits (up to `waitMs`), then takes it over; a file left by a dead pid, or an unreadable one, is replaced at
 * once. The caller checks `findRunning` after this returns, so a server that started meanwhile is found.
 */
export async function acquireStartLock(dataDir: string, opts: StartLockOptions = {}): Promise<() => Promise<void>> {
  const file = path.join(dataDir, START_FILE);
  const isAlive = opts.isAlive ?? pidAlive;
  const end = Date.now() + (opts.waitMs ?? 30_000);
  for (;;) {
    try {
      const fh = await open(file, "wx", 0o600);
      try {
        await fh.writeFile(String(process.pid));
      } finally {
        await fh.close();
      }
      return async () => {
        try {
          const owner = Number((await readFile(file, "utf8")).trim());
          if (owner === process.pid) await rm(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let owner = NaN;
    try {
      owner = Number((await readFile(file, "utf8")).trim());
    } catch {
      // removed meanwhile, or unreadable
    }
    const waiting = Number.isInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner) && Date.now() < end;
    if (!waiting) {
      // Stale (dead pid, our own, unreadable, or a start that never finished): take it over.
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
  }
}
