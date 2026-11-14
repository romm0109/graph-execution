// Resume a run (KAN-88): a sandboxed run in a new container, any other run with the engine on the server; and Stop
// sandbox, for a sandboxed run whose page no longer answers.
import type { FastifyInstance } from "fastify";
import { lockHost, readLock, RUNS_DIR, stateSchema, SUITE_FILE, suiteStateSchema } from "graph-execution/api";
import type { AppContext } from "../app.js";
import { agentKeyEnv } from "../sessions/logins.js";
import type { WorkspaceHost } from "../host/types.js";
import { ADMIN_USER, type User } from "../identity.js";
import { homeAsWorkspace, resolveRunHome, sandboxRepos, type RunHome } from "../runhome.js";
import { isRunId, runDirOf, viewUrlOf } from "../runs.js";
import { SandboxError } from "../sandbox-run.js";
import { lastLines, START_TIMEOUT_MS } from "../engine.js";

export interface ResumeOptions {
  /** Resume in a sandbox even when the run has no sign of one. */
  sandbox?: boolean;
  /** Who resumes (picks the host); the admin when unset. */
  user?: User;
}

function parseRunState(text: string | undefined) {
  if (text === undefined) return undefined;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseSuiteState(text: string | undefined) {
  if (text === undefined) return undefined;
  try {
    const parsed = suiteStateSchema.safeParse(JSON.parse(text));
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
  const host = await ctx.hostFor(home.id, opts.user ?? ADMIN_USER);
  // The resuming user's saved agent keys (Settings → Agents); none for a resume graph-manager starts itself.
  const keys = opts.user ? await agentKeyEnv(ctx.store, opts.user) : {};
  // A sandbox record and the image settings belong to the resuming user (the admin for one graph-manager resumes itself).
  const owner = await ctx.store.forUser(opts.user ?? ADMIN_USER);
  const runRel = `${RUNS_DIR}/${runId}`;
  const isLive = async (): Promise<boolean> => (await host.runDetail(home.id, runId))?.summary.live === true;
  if ((await host.stat(home.id, `${runRel}/${SUITE_FILE}`)) !== undefined) {
    if (home.kind !== "project") throw new SandboxError(400, "suites are resumed from a terminal");
    // A project run (MR-08): the suite is resumed in the project folder.
    const suite = parseSuiteState(await host.readFile(home.id, `${runRel}/${SUITE_FILE}`));
    if (!suite) throw new SandboxError(404, "unknown run");
    if (await isLive()) throw new SandboxError(409, "the run is live");
    if (suite.status === "applied" || suite.status === "done") throw new SandboxError(409, `the run already finished (${suite.status})`);
    if (opts.sandbox === true || suite.sandbox !== undefined || ctx.sandboxes?.recordOf(home.id, runId, owner) !== undefined) {
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
        extraEnv: keys,
        store: owner,
        ...(suite.sandbox?.image ? { image: suite.sandbox.image } : {}),
        ...(takeLockFrom ? { takeLockFrom } : {}),
      });
      return { runId, viewUrl: viewUrlOf(home.id, runId) };
    }
    await startResume(host, home, runId, ["suite", "--resume", "--run", runId, "--web"], keys);
    return { runId, viewUrl: viewUrlOf(home.id, runId) };
  }
  if (home.kind !== "workspace") throw new SandboxError(400, "only suites run in a project folder");
  const ws = home.workspace;
  const state = parseRunState(await host.readFile(home.id, `${runRel}/state.json`));
  if (!state) throw new SandboxError(404, "unknown run");
  if (await isLive()) throw new SandboxError(409, "the run is live");
  if (state.status === "applied" || state.status === "done") throw new SandboxError(409, `the run already finished (${state.status})`);

  const sandboxed = opts.sandbox === true || state.sandbox !== undefined || ctx.sandboxes?.recordOf(ws.id, runId, owner) !== undefined;
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
      extraEnv: keys,
      store: owner,
      ...(state.sandbox?.image ? { image: state.sandbox.image } : {}),
      ...(takeLockFrom ? { takeLockFrom } : {}),
    });
    return { runId, viewUrl: viewUrlOf(ws.id, runId) };
  }

  await startResume(host, home, runId, ["--resume", "--run", runId, "--web"], keys);
  return { runId, viewUrl: viewUrlOf(ws.id, runId) };
}

/** Runs the engine's resume command in the home; throws a `SandboxError` (400, with the output) when it fails. */
async function startResume(host: WorkspaceHost, home: RunHome, runId: string, args: string[], env: Record<string, string>): Promise<void> {
  const res = await host.startEngine({ workspaceId: home.id, args, env, timeoutMs: START_TIMEOUT_MS, resumeRunId: runId });
  if (!res.ok) {
    const err = new SandboxError(400, res.error, res.output) as SandboxError & { exitCode?: number };
    if (res.exitCode !== undefined) err.exitCode = res.exitCode;
    throw err;
  }
}

export async function resumeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId/resume", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const home = resolveRunHome(ctx.config.workspacesDir, await ctx.store.forUser(req.user), req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    try {
      return reply.code(201).send(await resumeRun(ctx, home, req.params.runId, { user: req.user }));
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
    const home = resolveRunHome(ctx.config.workspacesDir, await ctx.store.forUser(req.user), req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    if (!ctx.sandboxes || !(await ctx.sandboxes.stop(home.id, req.params.runId))) return reply.code(404).send({ error: "no sandbox for this run" });
    return reply.code(204).send();
  });
}
