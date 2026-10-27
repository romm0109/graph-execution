/**
 * Windows: runs an agent inside a Job Object, so whatever it starts dies with it.
 *
 * Windows has no process groups, and a process whose parent exited keeps no link to the agent, so `taskkill /T`
 * cannot find what an agent left running (e.g. a background `npm test` still holding files open in its worktree).
 * Instead the agent is started by a small PowerShell launcher that first puts itself in a new job created with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every process the agent starts, at any depth, joins the job. When the agent
 * exits the launcher terminates the job with the agent's exit code; if the launcher itself is killed (abort, or
 * graph-execution dying), the job's last handle closes and Windows kills everything in it.
 *
 * The agent inherits the launcher's stdin, stdout and stderr (the pipes `spawnAgent` reads), so its I/O is unchanged.
 * Where the job cannot be set up (PowerShell in constrained language mode, a parent job that forbids nesting) the
 * launcher prints a warning and runs the agent without one, as before.
 */
import { createRequire } from "node:module";

/** Set to `1` to start agents directly, without the job launcher. */
export const NO_JOB_ENV = "GRAPH_EXECUTION_NO_JOB";

const FILE_ENV = "GRAPH_EXECUTION_JOB_FILE";
const ARGS_ENV = "GRAPH_EXECUTION_JOB_ARGS";

const LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$job = [IntPtr]::Zero
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class GraphExecutionJob {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Io { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)]
  struct Extended {
    public Basic BasicLimits; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  public static IntPtr Enter() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended info = new Extended();
    info.BasicLimits.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    return job;
  }
}
'@
  $job = [GraphExecutionJob]::Enter()
} catch {
  [Console]::Error.WriteLine("graph-execution: running the agent without a job object, processes it leaves running may survive it: $($_.Exception.Message)")
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:${FILE_ENV}
$psi.Arguments = $env:${ARGS_ENV}
$psi.UseShellExecute = $false
$psi.WorkingDirectory = [Environment]::CurrentDirectory
[void]$psi.EnvironmentVariables.Remove('${FILE_ENV}')
[void]$psi.EnvironmentVariables.Remove('${ARGS_ENV}')
$agent = [System.Diagnostics.Process]::Start($psi)
$agent.WaitForExit()
$code = $agent.ExitCode
if ($job -ne [IntPtr]::Zero) {
  [void][GraphExecutionJob]::TerminateJobObject($job, [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$code), 0))
}
exit $code
`;

/** Quotes one argument for a Windows command line, by the rules `CommandLineToArgvW` and the C runtime parse it with. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** What cross-spawn would hand to `child_process.spawn`: `.cmd` shims become a `cmd.exe /d /s /c "..."` line. */
interface Parsed {
  command: string;
  args: string[];
  file?: string;
  options: { windowsVerbatimArguments?: boolean };
}

/** The program and command-line string the launcher starts, from cross-spawn's parse of `file` and `args`. */
export function commandLine(parsed: Parsed): { file: string; args: string } {
  return {
    file: parsed.command,
    args: parsed.options.windowsVerbatimArguments ? parsed.args.join(" ") : parsed.args.map(quoteWindowsArg).join(" "),
  };
}

const crossSpawnParse = (): ((file: string, args: string[], options: object) => Parsed) =>
  (createRequire(import.meta.url)("cross-spawn") as { _parse: (file: string, args: string[], options: object) => Parsed })
    ._parse;

/**
 * The launcher invocation that runs `file args` in `cwd` inside a job, or `undefined` to start the agent directly:
 * when disabled through `NO_JOB_ENV`, or when `file` is not found (the direct start then reports it as before).
 */
export function jobLaunch(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env: Record<string, string> } | undefined {
  if (env[NO_JOB_ENV] === "1") return undefined;
  const parsed = crossSpawnParse()(file, args, { cwd, env });
  if (!parsed.file) return undefined;
  const line = commandLine(parsed);
  return {
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      // Leaves stdin alone: the agent inherits it and reads its prompt there.
      "-InputFormat",
      "None",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(LAUNCHER, "utf16le").toString("base64"),
    ],
    env: { [FILE_ENV]: line.file, [ARGS_ENV]: line.args },
  };
}
