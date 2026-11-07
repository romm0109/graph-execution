import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { openInBrowser } from "../readme/readme.js";
import { EXIT_ABORT, EXIT_HANDOFF_BLOCKED, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { findOnPath } from "../providers/index.js";
import {
  handoff as realHandoff,
  planHandoff,
  readLogTail,
  waitForReady as realWaitForReady,
  type HandoffPlan,
} from "./handoff.js";
import { assertNotRunning, preflight, type PreflightOptions } from "./preflight.js";
import { isAlive } from "../state/state.js";
import { quoteFor } from "./quote.js";
import { writeLaunchScript } from "./script.js";

export interface LaunchOptions {
  /** The user's arguments (without the node and script paths), `--web` already removed. */
  args: string[];
  /** Checks a run; without it (and without `check`) nothing is checked. */
  preflight?: PreflightOptions;
  /** Runs instead of `preflight`, for what is not a single run (a suite). */
  check?: () => Promise<void>;
  /** What is started, for the printed messages. */
  noun?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface LaunchDeps {
  handoff?: typeof realHandoff;
  waitForReady?: typeof realWaitForReady;
  open?: (url: string) => Promise<boolean>;
  out?: (text: string) => void;
  /** stderr lines. */
  err?: (text: string) => void;
  cliPath?: string;
}

/**
 * `--web`: checks everything a run checks, hands the run to the OS as a detached `--web-serve` process, waits for its
 * page and opens it. Creates no run folder; the run process does. Returns the launcher's exit code.
 *
 * `GRAPH_EXECUTION_HANDOFF` (internal, for tests): `detached` skips the OS services, `none` makes every choice fail.
 */
export async function launchWeb(opts: LaunchOptions, deps: LaunchDeps = {}): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out = deps.out ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const noun = opts.noun ?? "run";
  if (opts.check) await opts.check();
  else if (opts.preflight) {
    const pre = await preflight(opts.preflight);
    if (pre.kind === "resume") await assertNotRunning(pre.runDir);
  }

  const id = randomBytes(4).toString("hex");
  const cliPath = deps.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
  const script = await writeLaunchScript({
    platform,
    env,
    cwd: opts.cwd,
    execPath: process.execPath,
    cliPath,
    args: opts.args,
    taskName: platform === "win32" ? `graph-execution-${id}` : undefined,
  });

  const mode = env.GRAPH_EXECUTION_HANDOFF;
  let plan: HandoffPlan = planHandoff(platform, { script: script.script, id }, (bin) => findOnPath(bin, opts.cwd, env, platform) !== undefined);
  if (mode === "detached") plan = { ...plan, steps: plan.steps.filter((s) => s.kind === "detached") };
  if (mode === "none") plan = { steps: [] };
  const started = await (deps.handoff ?? realHandoff)(plan);
  if (!started.ok) {
    const q = (v: string): string => quoteFor(platform, v);
    out(`Could not start the ${noun} in the background (${started.reason}). Run this in a terminal:`);
    out(`cd ${q(opts.cwd)}`);
    out(["graph-execution", ...opts.args.map(q)].join(" "));
    return EXIT_HANDOFF_BLOCKED;
  }

  const ready = await (deps.waitForReady ?? realWaitForReady)({
    readyFile: script.readyFile,
    isRunAlive: () => {
      // The script records the run process's PID (POSIX); until then, or without a PID file, assume it is alive.
      let pid: number;
      try {
        pid = Number.parseInt(readFileSync(script.pidFile, "utf8"), 10);
      } catch {
        return true;
      }
      return !Number.isFinite(pid) || isAlive(pid);
    },
    readLogTail: readLogTail(script.logFile),
  });
  const dropScript = (): Promise<void> => rm(script.dir, { recursive: true, force: true }).catch(() => {});
  if (!ready.ok) {
    err(`error: the ${noun} did not start`);
    if (ready.log) err(ready.log);
    await dropScript();
    return EXIT_ABORT;
  }

  await dropScript();
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (!ssh && (await (deps.open ?? openInBrowser)(ready.url).catch(() => false))) {
    out(`Started ${noun} ${ready.runId} in the background: ${ready.url}`);
    return EXIT_SUCCESS;
  }
  out(`${noun[0]!.toUpperCase()}${noun.slice(1)} ${ready.runId} started: ${ready.url}`);
  if (ssh) {
    const port = new URL(ready.url).port;
    out(`From your machine: ssh -L ${port}:127.0.0.1:${port} ${os.hostname()}, then open http://127.0.0.1:${port}/`);
  }
  return EXIT_SUCCESS;
}
