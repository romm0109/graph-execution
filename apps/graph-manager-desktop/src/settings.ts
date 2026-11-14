import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopSettings {
  mode?: "local" | "remote";
  remoteUrl?: string;
  bounds?: Bounds;
}

const FILE = "desktop.json";
/** Windows rename codes worth retrying: another process (an antivirus scan, a reader) has the target open. */
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_TRIES = 5;
const RENAME_DELAY_MS = 50;

const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const httpUrl = z.string().refine((s) => {
  try {
    const { protocol } = new URL(s);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
});

/** The settings in `<dir>/desktop.json`; `{}` when the file is missing, unreadable or invalid. */
export function readSettings(dir: string): DesktopSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, FILE), "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  // Each field is checked on its own, so one bad field (or an old key such as `localPassword`) drops only itself.
  const out: DesktopSettings = {};
  const mode = z.enum(["local", "remote"]).safeParse(obj.mode);
  if (mode.success) out.mode = mode.data;
  const remoteUrl = httpUrl.safeParse(obj.remoteUrl);
  if (remoteUrl.success) out.remoteUrl = remoteUrl.data;
  const bounds = boundsSchema.safeParse(obj.bounds);
  if (bounds.success) out.bounds = bounds.data;
  return out;
}

/** Writes `<dir>/desktop.json` atomically (temp file + rename), mode 0o600 where supported. */
export function writeSettings(dir: string, s: DesktopSettings, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const data: DesktopSettings = {};
  if (s.mode !== undefined) data.mode = s.mode;
  if (s.remoteUrl !== undefined) data.remoteUrl = s.remoteUrl;
  if (s.bounds !== undefined) data.bounds = s.bounds;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameRetrying(tmp, file, platform);
}

/**
 * `renameSync` that retries on Windows, where a rename over a file another process has open fails with EPERM. Mirrors
 * graph-execution's `renameReplacing` (used by graph-manager's `store.ts`), synchronously and with a shorter budget.
 */
function renameRetrying(from: string, to: string, platform: NodeJS.Platform): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !RETRY_CODES.has(code) || attempt >= RENAME_TRIES) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_DELAY_MS);
    }
  }
}
