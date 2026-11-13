import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { ExtraArgsError, runOptionsSchema, startArgs, type RunOptionsBody } from "../runoptions.js";
import { isRunId, listRuns, listWorkspaceRuns, runDetail, viewUrlOf } from "../runs.js";
import { StartError, startEngine } from "../start-run.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";

export { engineCommand, engineEnv, INTERNAL_ENV, lastLines, START_TIMEOUT_MS } from "../start-run.js";

export const PROVIDERS = ["claude", "codex", "opencode", "qwen", "fake"] as const;

const startBody = z.object({
  tasksDir: z.string().min(1),
  spec: z.string().min(1),
  provider: z.enum(PROVIDERS),
  concurrency: z.number().int().min(1).max(64).optional(),
  options: runOptionsSchema.optional(),
  sandbox: z.boolean().optional(),
});

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

/** Saves the last value of "Run in sandbox" for the workspace. */
async function rememberSandbox(ctx: AppContext, id: string, on: boolean): Promise<void> {
  await ctx.store.update((d) => {
    d.workspaceSettings[id] = { ...d.workspaceSettings[id], sandbox: on };
  });
}

function workspaceOr404(ctx: AppContext, id: string): Workspace | undefined {
  return resolveWorkspace(ctx.config.workspacesDir, id);
}

export async function runsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { workspace?: string } }>("/api/runs", async (req) => {
    const filter = req.query.workspace;
    const { prs, apiRuns } = ctx.store.get();
    if (filter) {
      const ws = workspaceOr404(ctx, filter);
      return { runs: ws ? await listWorkspaceRuns(ws, prs, ctx.config.dataDir, apiRuns) : [] };
    }
    return { runs: await listRuns(ctx.config.workspacesDir, prs, ctx.config.dataDir, apiRuns) };
  });

  app.get<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = workspaceOr404(ctx, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const detail = await runDetail(ws, req.params.runId, ctx.config.dataDir);
    if (!detail) return reply.code(404).send({ error: "unknown run" });
    return detail;
  });

  app.post<{ Params: { ws: string } }>("/api/runs/:ws", async (req, reply) => {
    const ws = workspaceOr404(ctx, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
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

    let id: string;
    try {
      id = await startEngine(ctx, ws, { runId, args, provider: body.provider, sandbox: body.sandbox === true });
    } catch (err) {
      if (err instanceof StartError) return reply.code(err.status).send({ error: err.message, ...err.extra });
      throw err;
    }
    await rememberSandbox(ctx, ws.id, body.sandbox === true);
    await saveDefaults();
    return reply.code(201).send({ runId: id, viewUrl: viewUrlOf(ws.id, id) });
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/run-defaults", async (req, reply) => {
    const ws = workspaceOr404(ctx, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return ctx.store.get().runDefaults[ws.id] ?? {};
  });
}
