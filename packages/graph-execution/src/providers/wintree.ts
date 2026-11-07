import { execa } from "execa";

/** One row of the Windows process table. `created` is ms since the epoch, 0 when Windows does not report it. */
export interface WinProcess {
  pid: number;
  ppid: number;
  created: number;
}

/** Clock slack between our `Date.now()` and Windows' process creation times, in ms. */
const SLACK_MS = 2000;

/**
 * The processes an agent left running, found from a process table taken after it exited. Windows does not re-parent
 * orphans: their `ppid` still names the dead agent, so its tree can be walked even though `taskkill /T` (which starts
 * from a live PID) no longer can. PIDs are reused, so creation times keep the walk honest: a direct child must have
 * been created while the agent ran (`startedAt` … `exitedAt`), and each deeper process no earlier than its parent; a
 * process whose `ppid` points at a reused PID was created before that PID's current owner and is left alone.
 */
export function leftoverDescendants(
  procs: readonly WinProcess[],
  agentPid: number,
  startedAt: number,
  exitedAt: number,
): number[] {
  const children = new Map<number, WinProcess[]>();
  for (const p of procs) {
    if (p.pid === p.ppid || p.pid === 0) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const found: number[] = [];
  const seen = new Set<number>([agentPid]);
  const queue = (children.get(agentPid) ?? []).filter(
    (c) => c.created >= startedAt - SLACK_MS && c.created <= exitedAt + SLACK_MS,
  );
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    found.push(p.pid);
    for (const c of children.get(p.pid) ?? []) if (c.created >= p.created) queue.push(c);
  }
  return found;
}

/** Parses the `pid ppid createdMs` lines that `listWindowsProcesses` asks PowerShell for; malformed lines are skipped. */
export function parseProcessTable(stdout: string): WinProcess[] {
  const out: WinProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]) });
  }
  return out;
}

const LIST_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  "$c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; " +
  '"$($_.ProcessId) $($_.ParentProcessId) $c" }';

/** The PowerShell argv that prints the process table; `-EncodedCommand` keeps the script clear of any quoting. */
export function listProcessesArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(LIST_SCRIPT, "utf16le").toString("base64")];
}

/** The Windows process table; empty when PowerShell is missing or fails. */
export async function listWindowsProcesses(): Promise<WinProcess[]> {
  const res = await execa("powershell.exe", listProcessesArgs(), { reject: false, timeout: 15_000, windowsHide: true });
  return res.exitCode === 0 ? parseProcessTable(res.stdout) : [];
}

/**
 * When the Windows process `pid` was created, in ms since the epoch; undefined when it is gone or unknown.
 * `Get-Process` reads the process directly; `Get-CimInstance` goes through WMI, which can take many seconds on a
 * busy machine.
 */
export async function windowsProcessCreated(pid: number): Promise<number | undefined> {
  const script =
    `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue; ` +
    "if ($p -and $p.StartTime) { ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }";
  const res = await execa(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { reject: false, timeout: 30_000, windowsHide: true },
  );
  const ms = Number(String(res.stdout ?? "").trim());
  return res.exitCode === 0 && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The image name of the Windows process `pid` (e.g. `node.exe`), lower case; `null` when Windows lists no such
 * process (it exited, even if its PID still answers `process.kill(pid, 0)` while a handle to it is open); undefined
 * when `tasklist` could not tell.
 */
export async function windowsProcessImage(pid: number): Promise<string | null | undefined> {
  const res = await execa("tasklist", ["/FI", `PID eq ${Math.trunc(pid)}`, "/FO", "CSV", "/NH"], {
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (res.exitCode !== 0) return undefined;
  const m = /^"([^"]+)","(\d+)"/m.exec(String(res.stdout ?? ""));
  return m && Number(m[2]) === Math.trunc(pid) ? m[1]!.toLowerCase() : null;
}

export interface KillLeftoversDeps {
  list?: () => Promise<WinProcess[]>;
  kill?: (pids: number[]) => Promise<void>;
}

async function taskkill(pids: number[]): Promise<void> {
  await execa("taskkill", ["/F", "/T", ...pids.flatMap((p) => ["/PID", String(p)])], {
    reject: false,
    stdio: "ignore",
    windowsHide: true,
  });
}

/**
 * Windows: kills whatever the agent `agentPid` (run from `startedAt` to `exitedAt`) left running, the way POSIX kills
 * the rest of its process group (GE-14). Best effort: never throws. Returns the PIDs it tried to kill.
 */
export async function killLeftovers(
  agentPid: number,
  startedAt: number,
  exitedAt: number,
  deps: KillLeftoversDeps = {},
): Promise<number[]> {
  try {
    const pids = leftoverDescendants(await (deps.list ?? listWindowsProcesses)(), agentPid, startedAt, exitedAt);
    if (pids.length > 0) await (deps.kill ?? taskkill)(pids);
    return pids;
  } catch {
    return [];
  }
}
