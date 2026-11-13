/**
 * Starting graph-execution for a new run, shared by the cookie Start run (`POST /api/runs/:ws`) and the automation API
 * (`POST /api/v1/workspaces/:ws/runs`). Imports nothing from ./routes/* (they import this).
 */
import { existsSync } from "node:fs";
import { execa } from "execa";
import { REVIEWERS_ENV, RUN_ID_ENV } from "graph-execution/api";
import type { AppContext } from "./app.js";
import { reviewersFilePath } from "./reviewers.js";
import { isRunId } from "./runs.js";
import { SandboxError } from "./sandbox-run.js";
import type { Workspace } from "./workspaces.js";

export const START_TIMEOUT_MS = 120_000;
export const INTERNAL_ENV = ["GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE", "GRAPH_EXECUTION_TASK_NAME"];
/** graph-manager's own secrets: never passed to an engine (or the agents it spawns). */
export const SECRET_ENV = ["GM_PASSWORD", "GM_EXTENSION_SECRET"];

/**
 * The environment of a local engine process (start or resume): `base` plus `extra`, without graph-manager's secrets
 * (SECRET_ENV) and without the internal variables that would tie the run to another run's folder or launcher.
 */
export function engineEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1", ...extra };
  for (const name of [...SECRET_ENV, ...INTERNAL_ENV]) delete env[name];
  return env;
}

/** The graph-execution command line: `node <cli.js> …` for a `.js` bin, else the bin itself. */
export function engineCommand(bin: string, args: string[]): { file: string; args: string[] } {
  return /\.[cm]?js$/.test(bin) ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

export const lastLines = (text: string, n: number): string => text.trimEnd().split("\n").slice(-n).join("\n");

/** A start that failed: the HTTP status and the JSON body to answer with. */
export class StartError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: { exitCode?: number; output?: string } = {},
  ) {
    super(message);
  }
}

/**
 * Starts graph-execution in the workspace with `args` (ending in "--web"): in a new sandbox container (without
 * "--web") or as a detached local process. Returns the run id the engine reports (else `runId`). Throws StartError.
 */
export async function startEngine(
  ctx: AppContext,
  ws: Workspace,
  p: { runId: string; args: string[]; provider: string; sandbox: boolean },
): Promise<string> {
  const { runId, args, provider } = p;
  // Sandboxed (KAN-88): the run gets its own container; never `--web` (the container adds `--web-serve`).
  if (p.sandbox) {
    if (!ctx.sandboxes) throw new StartError(400, "sandboxes are not set up");
    const sbArgs = args.filter((a) => a !== "--web");
    try {
      await ctx.sandboxes.start({ ws, cwd: ws.path, args: sbArgs, runId, providers: [provider] });
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new StartError(err.status, err.message, err.output ? { output: lastLines(err.output, 20) } : {});
      }
      throw err;
    }
    return runId;
  }

  const env = engineEnv(process.env, { [RUN_ID_ENV]: runId });
  const reviewersFile = reviewersFilePath(ctx.config.dataDir);
  if (existsSync(reviewersFile)) env[REVIEWERS_ENV] = reviewersFile;
  const cmd = engineCommand(ctx.config.graphExecutionBin, args);
  const res = await execa(cmd.file, cmd.args, {
    cwd: ws.path,
    env,
    extendEnv: false,
    reject: false,
    all: true,
    stdin: "ignore",
    timeout: START_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) {
    const output = typeof res.all === "string" && res.all.trim() !== "" ? res.all : (res.message ?? "");
    const tail = lastLines(output, 20);
    const exitCode = typeof res.exitCode === "number" ? res.exitCode : undefined;
    throw new StartError(400, tail || `graph-execution exited ${String(res.exitCode)}`, {
      ...(exitCode !== undefined ? { exitCode } : {}),
      output: tail,
    });
  }
  // The run id we set reaches the detached run (GRAPH_EXECUTION_* variables pass through); trust stdout if it differs.
  const printed = /\b(?:Started run|Run) (\S+)(?: in the background)?(?::| started:)/.exec(res.stdout)?.[1];
  return printed && isRunId(printed) ? printed : runId;
}
