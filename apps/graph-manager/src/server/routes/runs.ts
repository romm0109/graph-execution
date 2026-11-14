import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { REVIEWERS_ENV, RUN_ID_ENV } from "graph-execution/api";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { ExtraArgsError, projectStartArgs, runOptionsSchema, startArgs, type RunOptionsBody } from "../runoptions.js";
import { reviewersFilePath } from "../reviewers.js";
import { isRunId, listHomeRuns, listRuns, runDetail, viewUrlOf } from "../runs.js";
import { homeAsWorkspace, resolveRunHome, sandboxRepos, type RunHome } from "../runhome.js";
import { SandboxError } from "../sandbox-run.js";
import type { Workspace } from "../workspaces.js";

export const PROVIDERS = ["claude", "codex", "opencode", "qwen", "fake"] as const;

const startBody = z.object({
  tasksDir: z.string().min(1),
  spec: z.string().min(1),
  provider: z.enum(PROVIDERS),
  concurrency: z.number().int().min(1).max(64).optional(),
  options: runOptionsSchema.optional(),
  sandbox: z.boolean().optional(),
});

/** A project start: no paths (the project folder's `specs/` and `tasks/` are the input). */
const projectStartBody = z.object({
  provider: z.enum(PROVIDERS),
  concurrency: z.number().int().min(1).max(64).optional(),
  options: runOptionsSchema.optional(),
  sandbox: z.boolean().optional(),
});

export const START_TIMEOUT_MS = 120_000;
export const INTERNAL_ENV = ["GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE", "GRAPH_EXECUTION_TASK_NAME"];

const pad = (n: number): string => String(n).padStart(2, "0");

/** `gm-<yyyymmdd-hhmmss>-<4 hex>` in local time. */
export function newRunId(now = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `gm-${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/** `rel` resolved inside the workspace (symlinks followed), or undefined when it escapes it or does not exist. */
export function insideWorkspace(ws: Workspace, rel: string): string | undefined {
  if (path.isAbsolute(rel) || rel.includes("\0")) return undefined;
  const full = path.resolve(ws.path, rel);
  if (!existsSync(full)) return undefined;
  const real = realpathSync(full);
  const root = realpathSync(ws.path);
  return real === root || real.startsWith(root + path.sep) ? full : undefined;
}

/** The graph-execution command line: `node <cli.js> …` for a `.js` bin, else the bin itself. */
export function engineCommand(bin: string, args: string[]): { file: string; args: string[] } {
  return /\.[cm]?js$/.test(bin) ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

export const lastLines = (text: string, n: number): string => text.trimEnd().split("\n").slice(-n).join("\n");

/** Saves the last value of "Run in sandbox" for the workspace. */
async function rememberSandbox(ctx: AppContext, id: string, on: boolean): Promise<void> {
  await ctx.store.update((d) => {
    d.workspaceSettings[id] = { ...d.workspaceSettings[id], sandbox: on };
  });
}

/** The workspace or project (`project~<id>`) with this id. */
function homeOr404(ctx: AppContext, id: string): RunHome | undefined {
  return resolveRunHome(ctx.config.workspacesDir, ctx.store, id);
}

/** The environment of an engine start: detached, no browser, without graph-manager's own secrets and run variables. */
function engineEnv(ctx: AppContext, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1", [RUN_ID_ENV]: runId };
  const reviewersFile = reviewersFilePath(ctx.config.dataDir);
  if (existsSync(reviewersFile)) env[REVIEWERS_ENV] = reviewersFile;
  delete env.GM_PASSWORD;
  // Internal variables that would tie the new run to another run's folder or launcher.
  for (const name of INTERNAL_ENV) delete env[name];
  return env;
}

type Started = { ok: true; stdout: string } | { ok: false; error: string; exitCode?: number; output: string };

/** Runs the engine in `cwd` until it has handed the run off to the background. */
async function startEngine(ctx: AppContext, cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Started> {
  const cmd = engineCommand(ctx.config.graphExecutionBin, args);
  const res = await execa(cmd.file, cmd.args, { cwd, env, extendEnv: false, reject: false, all: true, stdin: "ignore", timeout: START_TIMEOUT_MS });
  if (res.exitCode !== 0) {
    const output = typeof res.all === "string" && res.all.trim() !== "" ? res.all : (res.message ?? "");
    const tail = lastLines(output, 20);
    const exitCode = typeof res.exitCode === "number" ? res.exitCode : undefined;
    return { ok: false, error: tail || `graph-execution exited ${String(res.exitCode)}`, exitCode, output: tail };
  }
  return { ok: true, stdout: String(res.stdout ?? "") };
}

export async function runsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { workspace?: string } }>("/api/runs", async (req) => {
    const filter = req.query.workspace;
    const prs = ctx.store.get().prs;
    if (filter) {
      const home = homeOr404(ctx, filter);
      return { runs: home ? await listHomeRuns(home, prs, ctx.config.dataDir) : [] };
    }
    return { runs: await listRuns(ctx.config.workspacesDir, prs, ctx.config.dataDir, ctx.store.get().projects) };
  });

  app.get<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const home = homeOr404(ctx, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    const detail = await runDetail(home, req.params.runId, ctx.config.dataDir);
    if (!detail) return reply.code(404).send({ error: "unknown run" });
    return detail;
  });

  app.post<{ Params: { ws: string } }>("/api/runs/:ws", async (req, reply) => {
    const home = homeOr404(ctx, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });

    // A project (MR-08): a multi-repo suite, started in the project folder.
    if (home.kind === "project") {
      const body = projectStartBody.parse(req.body ?? {});
      const options: RunOptionsBody = { ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}), ...body.options };
      let args: string[];
      try {
        args = projectStartArgs({ provider: body.provider, options });
      } catch (err) {
        if (err instanceof ExtraArgsError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      const wanted = `suite-${newRunId()}`;
      const saveProjectDefaults = (): Promise<void> =>
        ctx.store
          .update((d) => {
            d.runDefaults[home.id] = { provider: body.provider, tasksDir: "", spec: "", options };
          })
          .catch((err: unknown) => req.log.warn({ err }, "could not save the run defaults"));
      // Sandboxed: the suite gets its own container with the project folder and every repo mounted; the engine
      // takes the suite id from GRAPH_EXECUTION_RUN_ID, so the container, record and ready file know it up front.
      if (body.sandbox === true) {
        if (!ctx.sandboxes) return reply.code(400).send({ error: "sandboxes are not set up" });
        const { repos, missing } = await sandboxRepos(ctx.config.workspacesDir, home);
        if (missing !== undefined) return reply.code(409).send({ error: `repo ${missing} has no workspace` });
        try {
          await ctx.sandboxes.start({
            ws: homeAsWorkspace(home),
            cwd: home.path,
            args: args.filter((a) => a !== "--web"),
            runId: wanted,
            providers: [body.provider],
            repos,
          });
        } catch (err) {
          if (err instanceof SandboxError) {
            return reply.code(err.status).send({ error: err.message, ...(err.output ? { output: lastLines(err.output, 20) } : {}) });
          }
          throw err;
        }
        await rememberSandbox(ctx, home.id, true);
        await saveProjectDefaults();
        return reply.code(201).send({ runId: wanted, viewUrl: viewUrlOf(home.id, wanted) });
      }
      const res = await startEngine(ctx, home.path, args, engineEnv(ctx, wanted));
      if (!res.ok) return reply.code(400).send({ error: res.error, exitCode: res.exitCode, output: res.output });
      const printed = /\b(?:Started suite|Suite) (suite-\S+?)(?: in the background)?(?::| started:)/.exec(res.stdout)?.[1];
      const id = printed && isRunId(printed) ? printed : isRunId(wanted) ? wanted : undefined;
      if (id === undefined) return reply.code(400).send({ error: "graph-execution did not print the id of the suite", output: lastLines(res.stdout, 20) });
      await rememberSandbox(ctx, home.id, false);
      await saveProjectDefaults();
      return reply.code(201).send({ runId: id, viewUrl: viewUrlOf(home.id, id) });
    }

    const ws = home.workspace;
    const body = startBody.parse(req.body ?? {});
    const tasksDir = insideWorkspace(ws, body.tasksDir);
    if (!tasksDir) return reply.code(400).send({ error: `tasksDir: ${body.tasksDir} is not a folder inside the workspace` });
    const spec = insideWorkspace(ws, body.spec);
    if (!spec) return reply.code(400).send({ error: `spec: ${body.spec} is not a file inside the workspace` });

    const runId = newRunId();
    // The top-level `concurrency` is kept for older clients; `options.concurrency` wins when both are given.
    const options: RunOptionsBody = { ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}), ...body.options };
    let args: string[];
    try {
      args = startArgs({ tasksDir: body.tasksDir, spec: body.spec, provider: body.provider, options });
    } catch (err) {
      if (err instanceof ExtraArgsError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    const saveDefaults = (): Promise<void> =>
      ctx.store
        .update((d) => {
          d.runDefaults[ws.id] = { provider: body.provider, tasksDir: body.tasksDir, spec: body.spec, options };
        })
        .catch((err: unknown) => req.log.warn({ err }, "could not save the run defaults"));

    // Sandboxed (KAN-88): the run gets its own container; never `--web` (the container adds `--web-serve`).
    if (body.sandbox === true) {
      if (!ctx.sandboxes) return reply.code(400).send({ error: "sandboxes are not set up" });
      const sbArgs = args.filter((a) => a !== "--web");
      try {
        await ctx.sandboxes.start({ ws, cwd: ws.path, args: sbArgs, runId, providers: [body.provider] });
      } catch (err) {
        if (err instanceof SandboxError) {
          return reply.code(err.status).send({ error: err.message, ...(err.output ? { output: lastLines(err.output, 20) } : {}) });
        }
        throw err;
      }
      await rememberSandbox(ctx, ws.id, true);
      await saveDefaults();
      return reply.code(201).send({ runId, viewUrl: viewUrlOf(ws.id, runId) });
    }

    const res = await startEngine(ctx, ws.path, args, engineEnv(ctx, runId));
    if (!res.ok) return reply.code(400).send({ error: res.error, exitCode: res.exitCode, output: res.output });
    // The run id we set reaches the detached run (GRAPH_EXECUTION_* variables pass through); trust stdout if it differs.
    const printed = /\b(?:Started run|Run) (\S+)(?: in the background)?(?::| started:)/.exec(res.stdout)?.[1];
    const id = printed && isRunId(printed) ? printed : runId;
    await rememberSandbox(ctx, ws.id, false);
    await saveDefaults();
    return reply.code(201).send({ runId: id, viewUrl: viewUrlOf(ws.id, id) });
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/run-defaults", async (req, reply) => {
    const home = homeOr404(ctx, req.params.id);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    return ctx.store.get().runDefaults[home.id] ?? {};
  });
}
