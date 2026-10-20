import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { z } from "zod";

type Argv = [command: string, args: string[]];

/** Runs each argv in turn; the step passes when all of them exit 0. */
export interface ExecStep {
  kind: "exec";
  commands: Argv[];
  /** Run by the run process once it is ready, to remove the OS task. */
  cleanup?: Argv;
}

/** Spawns in a new session and lets go of the child. */
export interface DetachedStep {
  kind: "detached";
  command: string;
  args: string[];
  windowsHide?: boolean;
}

export type Step = ExecStep | DetachedStep;

export interface HandoffPlan {
  steps: Step[];
  /** Scheduled task name (Windows); passed to the run process as `GRAPH_EXECUTION_TASK_NAME`. */
  taskName?: string;
}

/** `schtasks /tr` accepts at most 261 characters. */
const SCHTASKS_TR_MAX = 261;

export function planHandoff(
  platform: NodeJS.Platform,
  ctx: { script: string; id: string },
  which: (bin: string) => boolean,
): HandoffPlan {
  const { script, id } = ctx;
  const steps: Step[] = [];
  let taskName: string | undefined;
  if (platform === "darwin") {
    if (which("launchctl")) {
      steps.push({
        kind: "exec",
        commands: [["launchctl", ["submit", "-l", `graph-execution.${id}`, "--", "/bin/sh", script]]],
      });
    }
    steps.push({ kind: "detached", command: "/bin/sh", args: [script] });
  } else if (platform === "win32") {
    const name = `graph-execution-${id}`;
    const tr = `"${script}"`;
    if (which("schtasks") && tr.length <= SCHTASKS_TR_MAX) {
      taskName = name;
      steps.push({
        kind: "exec",
        commands: [
          ["schtasks", ["/create", "/tn", name, "/sc", "once", "/st", "00:00", "/f", "/tr", tr]],
          ["schtasks", ["/run", "/tn", name]],
        ],
        cleanup: ["schtasks", ["/delete", "/tn", name, "/f"]],
      });
    }
    steps.push({ kind: "detached", command: "cmd", args: ["/c", script], windowsHide: true });
  } else {
    if (which("systemd-run")) {
      steps.push({
        kind: "exec",
        commands: [["systemd-run", ["--user", "--collect", "--unit", `graph-execution-${id}`, "/bin/sh", script]]],
      });
    }
    steps.push({ kind: "detached", command: "/bin/sh", args: [script] });
  }
  return { steps, taskName };
}

export interface SpawnedChild {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

export interface HandoffOptions {
  /** Resolves the exit code of a synchronous OS command. */
  exec?: (command: string, args: string[]) => Promise<number>;
  spawn?: (step: DetachedStep) => SpawnedChild;
  /** How long a detached spawn has to fail before it counts as started. */
  settleMs?: number;
}

async function defaultExec(command: string, args: string[]): Promise<number> {
  const result = await execa(command, args, { reject: false, stdio: "ignore" });
  return result.failed ? (result.exitCode ?? 1) || 1 : (result.exitCode ?? 1);
}

function defaultSpawn(step: DetachedStep): SpawnedChild {
  return nodeSpawn(step.command, step.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: step.windowsHide,
  });
}

export async function handoff(
  plan: HandoffPlan,
  opts: HandoffOptions = {},
): Promise<{ ok: true; step: number } | { ok: false; reason: string }> {
  const exec = opts.exec ?? defaultExec;
  const spawn = opts.spawn ?? defaultSpawn;
  let reason = "no hand-off method available";
  for (const [i, step] of plan.steps.entries()) {
    if (step.kind === "exec") {
      let passed = true;
      for (const [command, args] of step.commands) {
        const code = await exec(command, args);
        if (code !== 0) {
          reason = `${command} ${args[0] ?? ""} exited with code ${code}`.replace(/ +/g, " ");
          passed = false;
          break;
        }
      }
      if (passed) return { ok: true, step: i };
      continue;
    }
    const error = await new Promise<Error | undefined>((resolve) => {
      let child: SpawnedChild;
      try {
        child = spawn(step);
      } catch (err) {
        resolve(err as Error);
        return;
      }
      const timer = setTimeout(() => {
        child.unref();
        resolve(undefined);
      }, opts.settleMs ?? 50);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(err);
      });
    });
    if (!error) return { ok: true, step: i };
    reason = `${step.command}: ${error.message}`;
  }
  return { ok: false, reason };
}

const ReadySchema = z.object({ url: z.string(), runId: z.string(), pid: z.number() });
export type Ready = z.infer<typeof ReadySchema>;

export interface WaitForReadyOptions {
  readyFile: string;
  timeoutMs?: number;
  pollMs?: number;
  /** False once the run process is known to be dead. */
  isRunAlive?: () => boolean;
  /** The last lines of `launch.log`, for the failure report. */
  readLogTail: () => Promise<string>;
}

/** The last `n` lines of `text`. */
export function tailLines(text: string, n = 20): string {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** Reads the last 20 lines of the log file; empty when it does not exist. */
export function readLogTail(logFile: string): () => Promise<string> {
  return async () => {
    try {
      return tailLines(await readFile(logFile, "utf8"));
    } catch {
      return "";
    }
  };
}

async function readReady(file: string): Promise<Ready | undefined> {
  try {
    const parsed = ReadySchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Missing, or half-written.
    return undefined;
  }
}

export async function waitForReady(
  opts: WaitForReadyOptions,
): Promise<({ ok: true } & Ready) | { ok: false; log: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const pollMs = opts.pollMs ?? 100;
  for (;;) {
    const ready = await readReady(opts.readyFile);
    if (ready) return { ok: true, ...ready };
    if ((opts.isRunAlive && !opts.isRunAlive()) || Date.now() >= deadline) {
      return { ok: false, log: tailLines(await opts.readLogTail()) };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
