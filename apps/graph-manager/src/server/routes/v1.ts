/**
 * The versioned automation API under /api/v1 (docs/prd/automation-api.md). Callers authenticate with a bearer API token
 * or the admin cookie (see auth.ts). Every route but ping carries `{ preHandler: requireScope(…) }`.
 */
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { apiAuthOf, requireScope } from "../auth.js";
import { removeRunInputs, writeRunInputs } from "../inputs.js";
import { ExtraArgsError, contentArgs, runOptionsSchema, splitExtraArgs } from "../runoptions.js";
import { abortRun, approveRun, rejectBody, rejectRun, resumeApiRun, sendActionError, startApiRunPr } from "../run-actions.js";
import { detailUrlOf, isRunId } from "../runs.js";
import { StartError, startEngine } from "../start-run.js";
import { V1_STATUSES, findRun, listFoundRuns, toRunObject, type FoundRun } from "../v1-runs.js";
import { listWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";
import { PROVIDERS, newRunId } from "./runs.js";

const listQuerySchema = z.object({
  workspace: z.string().min(1).optional(),
  status: z.enum(V1_STATUSES).optional(),
  ref: z.string().min(1).optional(),
});

const refSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  url: z
    .string()
    .max(2000)
    .regex(/^https?:\/\//i, "must be an http(s) URL")
    .optional(),
  title: z.string().max(500).optional(),
});

const startFromContent = z.object({
  content: z.string().min(1, "content is required").max(200_000, "content is longer than 200000 characters"),
  refs: z.array(refSchema).max(200).optional(),
  provider: z.enum(PROVIDERS).optional(),
  model: runOptionsSchema.shape.model,
  gate: z.enum(["approve", "auto"]).default("approve"),
  sandbox: z.boolean().default(true),
  openPr: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(200).optional(),
  options: runOptionsSchema.optional(),
});

export const NO_PROVIDER = "no provider: pass provider or start a run in this workspace once";

/** The HTTP answer of a start from content. */
type StartReply = { code: number; body: unknown };

/** Starts in flight per `<ws>/<idempotencyKey>`: a second request with the same key waits for the first. */
const inFlight = new Map<string, Promise<StartReply>>();

/** The run of an earlier start with this idempotency key in the workspace, while its run folder exists. */
async function earlierRun(ctx: AppContext, ws: Workspace, key: string): Promise<StartReply | undefined> {
  const prefix = `${ws.id}/`;
  for (const [k, rec] of Object.entries(ctx.store.get().apiRuns)) {
    if (!k.startsWith(prefix) || rec.idempotencyKey !== key) continue;
    const runId = k.slice(prefix.length);
    const found = await findRun(ctx, runId);
    if (found && found.ws.id === ws.id) return { code: 200, body: await toRunObject(ctx, found) };
  }
  return undefined;
}

export async function v1Routes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Scope-free: answers any valid token or cookie, so clients can check a token.
  app.get("/api/v1/ping", async () => ({ ok: true }));

  app.get("/api/v1/runs", { preHandler: requireScope("runs:read") }, async (req, reply) => {
    const q = listQuerySchema.parse(req.query);
    let ws;
    if (q.workspace !== undefined) {
      ws = resolveWorkspace(ctx.config.workspacesDir, q.workspace);
      if (!ws || !existsSync(ws.path)) return reply.code(404).send({ error: "unknown workspace" });
    }
    const all = await Promise.all((await listFoundRuns(ctx, ws)).map((r) => toRunObject(ctx, r)));
    const runs = all.filter((r) => (q.status === undefined || r.status === q.status) && (q.ref === undefined || r.refs.some((x) => x.ref === q.ref)));
    return { runs };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", { preHandler: requireScope("runs:read") }, async (req, reply) => {
    if (!isRunId(req.params.id)) return reply.code(404).send({ error: "unknown run" });
    const found = await findRun(ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown run" });
    return toRunObject(ctx, found);
  });

  const foundOf = async (id: string): Promise<FoundRun | undefined> => (isRunId(id) ? findRun(ctx, id) : undefined);
  type IdParams = { Params: { id: string } };

  app.post<IdParams>("/api/v1/runs/:id/approve", { preHandler: requireScope("runs:approve") }, async (req, reply) => {
    const found = await foundOf(req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown run" });
    try {
      return await approveRun(ctx, found);
    } catch (err) {
      return sendActionError(reply, err);
    }
  });

  app.post<IdParams>("/api/v1/runs/:id/reject", { preHandler: requireScope("runs:approve") }, async (req, reply) => {
    const found = await foundOf(req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown run" });
    const body = rejectBody.parse(req.body ?? {});
    try {
      return await rejectRun(ctx, found, body.feedback);
    } catch (err) {
      return sendActionError(reply, err);
    }
  });

  app.post<IdParams>("/api/v1/runs/:id/resume", { preHandler: requireScope("runs:control") }, async (req, reply) => {
    const found = await foundOf(req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown run" });
    try {
      return await resumeApiRun(ctx, found);
    } catch (err) {
      return sendActionError(reply, err);
    }
  });

  app.post<IdParams>("/api/v1/runs/:id/abort", { preHandler: requireScope("runs:control") }, async (req, reply) => {
    const found = await foundOf(req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown run" });
    try {
      return await abortRun(ctx, found);
    } catch (err) {
      return sendActionError(reply, err);
    }
  });

  app.post<IdParams>("/api/v1/runs/:id/pr", { preHandler: requireScope("runs:pr") }, async (req, reply) => {
    const found = await foundOf(req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown run" });
    try {
      return reply.code(202).send({ job: await startApiRunPr(ctx, found) });
    } catch (err) {
      return sendActionError(reply, err);
    }
  });

  app.get("/api/v1/workspaces", { preHandler: requireScope("workspaces:read") }, async () => {
    const { runDefaults } = ctx.store.get();
    const workspaces = (await listWorkspaces(ctx.config.workspacesDir)).map((ws) => {
      const parts = ws.fullPath.split("/");
      const defaultProvider = runDefaults[ws.id]?.provider;
      return {
        id: ws.id,
        forge: ws.forge,
        owner: parts.slice(0, -1).join("/"),
        repo: parts[parts.length - 1] ?? "",
        ...(defaultProvider ? { defaultProvider } : {}),
      };
    });
    return { workspaces };
  });

  app.post<{ Params: { ws: string } }>("/api/v1/workspaces/:ws/runs", { preHandler: requireScope("runs:start") }, async (req, reply) => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.ws);
    if (!ws || !existsSync(ws.path)) return reply.code(404).send({ error: "unknown workspace" });
    const body = startFromContent.parse(req.body ?? {});
    const refs = body.refs ?? [];
    const seen = new Set<string>();
    for (const r of refs) {
      if (seen.has(r.ref)) return reply.code(400).send({ error: `refs: duplicate ref ${r.ref}` });
      seen.add(r.ref);
    }

    const start = async (): Promise<StartReply> => {
      if (body.idempotencyKey !== undefined) {
        const earlier = await earlierRun(ctx, ws, body.idempotencyKey);
        if (earlier) return earlier;
      }
      const provider = body.provider ?? ctx.store.get().runDefaults[ws.id]?.provider;
      if (provider === undefined || !(PROVIDERS as readonly string[]).includes(provider)) {
        return { code: 400, body: { error: NO_PROVIDER } };
      }
      const options = { ...body.options, ...(body.model ? { model: body.model } : {}) };
      const runId = newRunId();
      let args: string[];
      try {
        // Checked before anything is written: bad extra arguments leave no inputs behind.
        splitExtraArgs(options.extraArgs);
        const paths = await writeRunInputs(
          ctx,
          ws,
          runId,
          [{ name: "content.md", text: body.content }, ...(refs.length ? [{ name: "refs.json", text: JSON.stringify(refs, null, 2) }] : [])],
          body.sandbox,
        );
        args = contentArgs({ content: paths["content.md"]!, refs: paths["refs.json"], gate: body.gate, provider, options });
      } catch (err) {
        if (err instanceof ExtraArgsError) return { code: 400, body: { error: err.message } };
        throw err;
      }
      let id: string;
      try {
        id = await startEngine(ctx, ws, { runId, args, provider, sandbox: body.sandbox });
      } catch (err) {
        // The run did not start: leave no inputs behind (`graph-execution clean` can't see a folder without state.json).
        await removeRunInputs(ctx, ws, runId).catch(() => undefined);
        if (err instanceof StartError) return { code: err.status, body: { error: err.message, ...err.extra } };
        throw err;
      }
      const auth = apiAuthOf(req);
      const startedBy = auth?.kind === "token" ? auth.id : "admin";
      await ctx.store.update((d) => {
        d.apiRuns[`${ws.id}/${id}`] = {
          refs,
          openPr: body.openPr,
          ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
          startedBy,
          createdAt: new Date().toISOString(),
        };
      });
      return { code: 201, body: { runId: id, viewUrl: detailUrlOf(ws.id, id) } };
    };

    if (body.idempotencyKey === undefined) {
      const res = await start();
      return reply.code(res.code).send(res.body);
    }
    const key = `${ws.id}/${body.idempotencyKey}`;
    const pending = inFlight.get(key);
    if (pending) {
      // The same key at the same time: answer with the first request's run.
      const first = await pending.catch(() => undefined);
      const earlier = await earlierRun(ctx, ws, body.idempotencyKey);
      if (earlier) return reply.code(200).send(earlier.body);
      if (first && first.code === 201) return reply.code(200).send(first.body);
    }
    const p = start();
    inFlight.set(key, p);
    try {
      const res = await p;
      return reply.code(res.code).send(res.body);
    } finally {
      if (inFlight.get(key) === p) inFlight.delete(key);
    }
  });
}
