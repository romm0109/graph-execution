// Resume a run (KAN-88): a sandboxed run in a new container, any other run with the engine on the server; and Stop
// sandbox, for a sandboxed run whose page no longer answers.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { lockHost, readLock, stateSchema, SUITE_FILE } from "graph-execution/api";
import type { AppContext } from "../app.js";
import { homeAsWorkspace, resolveRunHome, sandboxRepos, type RunHome } from "../runhome.js";
import { isRunId, livePage, readSuite, runDirOf, viewUrlOf } from "../runs.js";
import { SandboxError } from "../sandbox-run.js";
import { engineCommand, INTERNAL_ENV, lastLines, START_TIMEOUT_MS } from "./runs.js";

export interface ResumeOptions {
  /** Resume in a sandbox even when the run has no sign of one. */
  sandbox?: boolean;
}

async function readRunState(runDir: string) {
  const text = await readFile(path.join(runDir, "state.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resumes a run that is not live and not finished. Throws a `SandboxError` carrying the HTTP status for every
 * refusal (and for a failed engine start, with its output).
 */
export async function resumeRun(ctx: AppContext, home: RunHome, runId: string, opts: ResumeOptions = {}): Promise<{ runId: string; viewUrl: string }> {
  if (!isRunId(runId)) throw new SandboxError(400, "invalid run id");
  const runDir = runDirOf(home, runId);
  if (existsSync(path.join(runDir, SUITE_FILE))) {
    if (home.kind !== "project") throw new SandboxError(400, "suites are resumed from a terminal");
    // A project run (MR-08): the suite is resumed in the project folder.
    const suite = await readSuite(runDir);
    if (!suite) throw new SandboxError(404, "unknown run");
    if (await livePage(runDir)) throw new SandboxError(409, "the run is live");
    if (suite.status === "applied" || suite.status === "done") throw new SandboxError(409, `the run already finished (${suite.status})`);
    if (opts.sandbox === true || suite.sandbox !== undefined || ctx.sandboxes?.recordOf(home.id, runId) !== undefined) {
      const sandboxes = ctx.sandboxes;
      if (!sandboxes) throw new SandboxError(400, "sandboxes are not set up");
      const { repos, missing } = await sandboxRepos(ctx.config.workspacesDir, home);
      if (missing !== undefined) throw new SandboxError(409, `repo ${missing} has no workspace`);
      await sandboxes.release(home.id, runId);
      const lock = await readLock(runDir);
      const takeLockFrom = lock && lock.host !== lockHost() ? lock.host : undefined;
      await sandboxes.start({
        ws: homeAsWorkspace(home),
        cwd: home.path,
        args: ["suite", "--resume", "--run", runId],
        runId,
        providers: [suite.provider],
        repos,
        ...(suite.sandbox?.image ? { image: suite.sandbox.image } : {}),
        ...(takeLockFrom ? { takeLockFrom } : {}),
      });
      return { runId, viewUrl: viewUrlOf(home.id, runId) };
    }
    await startResume(ctx, home, runDir, ["suite", "--resume", "--run", runId, "--web"]);
    return { runId, viewUrl: viewUrlOf(home.id, runId) };
  }
  if (home.kind !== "workspace") throw new SandboxError(400, "only suites run in a project folder");
  const ws = home.workspace;
  const state = await readRunState(runDir);
  if (!state) throw new SandboxError(404, "unknown run");
  if (await livePage(runDir)) throw new SandboxError(409, "the run is live");
  if (state.status === "applied" || state.status === "done") throw new SandboxError(409, `the run already finished (${state.status})`);

  const sandboxed = opts.sandbox === true || state.sandbox !== undefined || ctx.sandboxes?.recordOf(ws.id, runId) !== undefined;
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
      args: ["--resume", "--run", runId],
      runId,
      providers: [state.provider],
      ...(state.sandbox?.image ? { image: state.sandbox.image } : {}),
      ...(takeLockFrom ? { takeLockFrom } : {}),
    });
    return { runId, viewUrl: viewUrlOf(ws.id, runId) };
  }

  await startResume(ctx, home, runDir, ["--resume", "--run", runId, "--web"]);
  return { runId, viewUrl: viewUrlOf(ws.id, runId) };
}

/** Runs the engine's resume command in the home; throws a `SandboxError` (400, with the output) when it fails. */
async function startResume(ctx: AppContext, home: RunHome, runDir: string, args: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1" };
  // A lock of another host on a run that is not sandboxed was left by graph-manager's previous container (its
  // hostname changes when it is recreated); that process is gone, so the lock may be taken over.
  const lock = await readLock(runDir).catch(() => undefined);
  if (lock && lock.host !== lockHost()) env.GRAPH_EXECUTION_TAKE_LOCK_FROM = lock.host;
  delete env.GM_PASSWORD;
  for (const name of INTERNAL_ENV) delete env[name];
  const cmd = engineCommand(ctx.config.graphExecutionBin, args);
  const res = await execa(cmd.file, cmd.args, {
    cwd: home.path,
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
}

export async function resumeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId/resume", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const home = resolveRunHome(ctx.config.workspacesDir, ctx.store, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    try {
      return reply.code(201).send(await resumeRun(ctx, home, req.params.runId));
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
    const home = resolveRunHome(ctx.config.workspacesDir, ctx.store, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    if (!ctx.sandboxes || !(await ctx.sandboxes.stop(home.id, req.params.runId))) return reply.code(404).send({ error: "no sandbox for this run" });
    return reply.code(204).send();
  });
}
