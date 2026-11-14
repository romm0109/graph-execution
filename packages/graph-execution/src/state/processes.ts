import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { Provider } from "../providers/types.js";
import { SANDBOX_ENV, TAKE_LOCK_FROM_ENV } from "./paths.js";
import { isAlive } from "./state.js";

/**
 * The process registry (KAN-67 / GE-06): every agent process a CLI starts is recorded in `<runDir>/pids/<pid>.json`
 * while it runs, so the agents of a CLI that was SIGKILLed or OOM-killed can be stopped by a later `--resume` or `clean`.
 */
export const PIDS_DIR = "pids";
export const pidsDir = (runDir: string): string => path.join(runDir, PIDS_DIR);

export interface ProcessRecord {
  pid: number;
  /** The agent's process group; equals `pid` on POSIX, where the agent leads its own group. */
  pgid: number;
  /** `processStartTime(pid)` at spawn: guards against a reused pid. */
  start?: string;
  /** The executable that was spawned. */
  command: string;
  label: string;
  role: string;
  /** The CLI process that spawned it. */
  owner: number;
  ownerStart?: string;
  /** os.hostname() of the CLI that spawned it; absent in records written before KAN-88 (= this host). */
  host?: string;
  /** Spawned in a graph-manager sandbox (informational; `reapOrphans` skips every record of another host). */
  sandbox?: boolean;
}

const WINDOWS = process.platform === "win32";

/** An opaque start-time token for `pid`, undefined when it is gone or unknown (Windows). Same pid + same token = same process. */
export function processStartTime(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the `(comm)`, which may contain spaces: index 0 is field 3 (state), index 19 is field 22 (starttime).
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    if (WINDOWS) return undefined;
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** POSIX: whether the process group still has members. A pgid is never reused as a pid while its group exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const recordFile = (runDir: string, pid: number): string => path.join(pidsDir(runDir), `${pid}.json`);

/** Writes the record synchronously, so a SIGKILL right after the spawn still leaves it on disk. Never throws. */
export function recordProcess(runDir: string, rec: ProcessRecord): void {
  try {
    mkdirSync(pidsDir(runDir), { recursive: true });
    writeFileSync(recordFile(runDir, rec.pid), JSON.stringify(rec));
  } catch {
    // Bookkeeping never fails an agent.
  }
}

/** Drops the record of an exited process. Never throws. */
export function forgetProcess(runDir: string, pid: number): void {
  try {
    rmSync(recordFile(runDir, pid), { force: true });
  } catch {
    // Bookkeeping never fails an agent.
  }
}

let ownStart: string | undefined | null = null;
const ownStartTime = (): string | undefined => {
  if (ownStart === null) ownStart = processStartTime(process.pid);
  return ownStart;
};

/** Records every process `provider` spawns in `<runDir>/pids` while it runs. */
export function trackProcesses(provider: Provider, runDir: string): Provider {
  return {
    name: provider.name,
    run: (opts) =>
      provider.run({
        ...opts,
        processHooks: {
          started: (pid, command) =>
            recordProcess(runDir, {
              pid,
              pgid: pid,
              start: processStartTime(pid),
              command,
              label: opts.label,
              role: opts.role,
              owner: process.pid,
              ownerStart: ownStartTime(),
              host: os.hostname(),
              ...(process.env[SANDBOX_ENV] === "1" ? { sandbox: true } : {}),
            }),
          exited: (pid) => forgetProcess(runDir, pid),
        },
      }),
  };
}

function isRecord(v: unknown): v is ProcessRecord {
  const r = v as Partial<ProcessRecord> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    Number.isInteger(r.pid) &&
    (r.pid ?? 0) > 0 &&
    Number.isInteger(r.pgid) &&
    (r.pgid ?? 0) > 0 &&
    Number.isInteger(r.owner) &&
    typeof r.command === "string" &&
    typeof r.label === "string" &&
    typeof r.role === "string" &&
    (r.host === undefined || typeof r.host === "string") &&
    (r.sandbox === undefined || typeof r.sandbox === "boolean")
  );
}

function ownerAlive(rec: ProcessRecord): boolean {
  if (rec.owner === process.pid) return true;
  if (!isAlive(rec.owner)) return false;
  if (rec.ownerStart === undefined) return true;
  const now = processStartTime(rec.owner);
  return now === undefined || now === rec.ownerStart;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function killGroup(pgid: number, graceMs: number): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return; // ESRCH: already gone.
  }
  for (const until = Date.now() + graceMs; Date.now() < until && groupAlive(pgid); ) await sleep(50);
  if (!groupAlive(pgid)) return;
  try {
    // A zombie still answers kill(0); SIGKILL is sent without waiting for confirmed death.
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function windowsImageMatches(rec: ProcessRecord): Promise<boolean> {
  try {
    const res = await execa("tasklist", ["/FI", `PID eq ${rec.pid}`, "/FO", "CSV", "/NH"], { reject: false });
    const name = path.parse(rec.command).name.toLowerCase();
    return name !== "" && String(res.stdout ?? "").toLowerCase().includes(name);
  } catch {
    return false;
  }
}

/**
 * Stops the agents recorded in `<dir>/pids` whose owning CLI is gone: SIGTERM to the process group, `graceMs`
 * (default 2000) to exit, then SIGKILL. A record whose pid now has another start time belongs to a different process
 * and is dropped without killing anything; records of a live owner (including this process) are kept. Windows: best
 * effort, `taskkill /T /F` when the image name still matches. A record of another host is
 * never signalled: it is kept, or deleted silently when `GRAPH_EXECUTION_TAKE_LOCK_FROM` names that host. Never throws; returns the records whose agents it stopped.
 */
export async function reapOrphans(
  dir: string,
  opts: { log?: (line: string) => void; graceMs?: number } = {},
): Promise<ProcessRecord[]> {
  const graceMs = opts.graceMs ?? 2000;
  const reaped: ProcessRecord[] = [];
  let names: string[];
  try {
    names = (await readdir(pidsDir(dir))).filter((n) => n.endsWith(".json"));
  } catch {
    return reaped;
  }
  for (const name of names) {
    const file = path.join(pidsDir(dir), name);
    let rec: ProcessRecord;
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isRecord(parsed)) continue;
      rec = parsed;
    } catch {
      continue;
    }
    try {
      if (rec.host !== undefined && rec.host !== os.hostname()) {
        // Another host's agents (e.g. a graph-manager sandbox): their pids mean nothing here. Never signal them.
        if (process.env[TAKE_LOCK_FROM_ENV] === rec.host) rmSync(file, { force: true });
        continue;
      }
      if (ownerAlive(rec)) continue;
      let killed = false;
      if (WINDOWS) {
        if (isAlive(rec.pid) && (await windowsImageMatches(rec))) {
          await execa("taskkill", ["/pid", String(rec.pid), "/T", "/F"], { reject: false, stdio: "ignore" });
          killed = true;
        }
      } else if (groupAlive(rec.pgid)) {
        // The leader may have died while the rest of the group lives on; only a live leader can be checked for reuse.
        const reused = rec.start !== undefined && isAlive(rec.pid) && processStartTime(rec.pid) !== rec.start;
        if (!reused) {
          await killGroup(rec.pgid, graceMs);
          killed = true;
        }
      }
      rmSync(file, { force: true });
      if (killed) {
        reaped.push(rec);
        opts.log?.(`stopped agent ${rec.label} (pid ${rec.pid}) left running by an earlier graph-execution process`);
      }
    } catch {
      // Bookkeeping never fails a run.
    }
  }
  return reaped;
}
