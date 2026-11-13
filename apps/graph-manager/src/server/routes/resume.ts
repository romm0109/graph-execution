// Resume a run (KAN-88): a sandboxed run in a new container, any other run with the engine on the server; and Stop
// sandbox, for a sandboxed run whose page no longer answers.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { lockHost, readLock, stateSchema, SUITE_FILE, type RunState } from "graph-execution/api";
import type { AppContext } from "../app.js";
import { isRunId, livePage, runDirOf, viewUrlOf } from "../runs.js";
import { SandboxError } from "../sandbox-run.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";
import { engineCommand, engineEnv, lastLines, START_TIMEOUT_MS } from "./runs.js";

export interface ResumeOptions {
  /** Resume in a sandbox even when the run has no sign of one. */
  sandbox?: boolean;
  /** The plan-approval flags passed to the engine: `["--approve-plan"]` or `["--replan", <path relative to the workspace root>]`. */
  planArgs?: string[];
}

/** The run's state.json, parsed; undefined when it is missing or invalid. */
export async function readRunState(runDir: string): Promise<RunState | undefined> {
  const text = await readFile(path.join(runDir, "state.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a resume of this run starts a sandbox: asked for, recorded in its state, or known to the sandbox service. */
export function isSandboxedRun(ctx: AppContext, ws: Workspace, runId: string, state: RunState | undefined, opts: ResumeOptions = {}): boolean {
  return opts.sandbox === true || state?.sandbox !== undefined || ctx.sandboxes?.recordOf(ws.id, runId) !== undefined;
}

/**
 * Resumes a run that is not live and not finished. Throws a `SandboxError` carrying the HTTP status for every
 * refusal (and for a failed engine start, with its output).
 */
export async function resumeRun(ctx: AppContext, ws: Workspace, runId: string, opts: ResumeOptions = {}): Promise<{ runId: string; viewUrl: string }> {
  if (!isRunId(runId)) throw new SandboxError(400, "invalid run id");
  const runDir = runDirOf(ws, runId);
  if (existsSync(path.join(runDir, SUITE_FILE))) throw new SandboxError(400, "suites are resumed from a terminal");
  const state = await readRunState(runDir);
  if (!state) throw new SandboxError(404, "unknown run");
  if (await livePage(runDir)) throw new SandboxError(409, "the run is live");
  if (state.status === "applied" || state.status === "done") throw new SandboxError(409, `the run already finished (${state.status})`);

  const planArgs = opts.planArgs ?? [];
  const sandboxed = isSandboxedRun(ctx, ws, runId, state, opts);
  if (sandboxed) {
    const sandboxes = ctx.sandboxes;
    if (!sandboxes) throw new SandboxError(400, "sandboxes are not set up");
    await sandboxes.release(ws.id, runId);
    const lock = await readLock(runDir);
    // The old container is gone (release): its lock, of another host, may be taken over.
    const takeLockFrom = lock && lock.host !== lockHost() ? lock.host : undefined;
    await sandboxes.start({
      ws,
      cwd: ws.path,
      args: ["--resume", "--run", runId, ...planArgs],
      runId,
      providers: [state.provider],
      ...(state.sandbox?.image ? { image: state.sandbox.image } : {}),
      ...(takeLockFrom ? { takeLockFrom } : {}),
    });
    return { runId, viewUrl: viewUrlOf(ws.id, runId) };
  }

  const env = engineEnv(process.env);
  // A lock of another host on a run that is not sandboxed was left by graph-manager's previous container (its
  // hostname changes when it is recreated); that process is gone, so the lock may be taken over.
  const lock = await readLock(runDir).catch(() => undefined);
  if (lock && lock.host !== lockHost()) env.GRAPH_EXECUTION_TAKE_LOCK_FROM = lock.host;
  const cmd = engineCommand(ctx.config.graphExecutionBin, ["--resume", "--run", runId, ...planArgs, "--web"]);
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
    const err = new SandboxError(400, tail || `graph-execution exited ${String(res.exitCode)}`, tail) as SandboxError & { exitCode?: number };
    if (typeof res.exitCode === "number") err.exitCode = res.exitCode;
    throw err;
  }
  return { runId, viewUrl: viewUrlOf(ws.id, runId) };
}

export async function resumeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId/resume", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    try {
      return reply.code(201).send(await resumeRun(ctx, ws, req.params.runId));
    } catch (err) {
      if (err instanceof SandboxError) {
        const exitCode = (err as SandboxError & { exitCode?: number }).exitCode;
        return reply.code(err.status).send({
          error: err.message,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(err.output ? { output: lastLines(err.output, 20) } : {}),
        });
      }
      throw err;
    }
  });

  app.post<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId/sandbox/stop", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    if (!ctx.sandboxes || !(await ctx.sandboxes.stop(ws.id, req.params.runId))) return reply.code(404).send({ error: "no sandbox for this run" });
    return reply.code(204).send();
  });
}
