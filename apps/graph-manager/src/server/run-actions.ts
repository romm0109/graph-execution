/**
 * Actions on existing runs (docs/prd/automation-api.md): approve or reject a plan, resume, abort, Create PR. Plain
 * functions shared by the /api/v1 routes (routes/v1.ts) and the UI's cookie routes below.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { writeRunInputs } from "./inputs.js";
import { PrError, startSuggestedPr, type PrJob } from "./pr.js";
import { pageTargetOf, upstreamPost } from "./proxy.js";
import { isSandboxedRun, resumeRun } from "./routes/resume.js";
import { isRunId, runDirOf, runSummaryOf } from "./runs.js";
import { SandboxError } from "./sandbox-run.js";
import { lastLines } from "./start-run.js";
import { findRun, toRunObject, type FoundRun, type RunObject } from "./v1-runs.js";
import { resolveWorkspace } from "./workspaces.js";

/** A refused or failed action: the HTTP status and the body to answer. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: { exitCode?: number; output?: string } = {},
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/** Answers an `ActionError`; rethrows anything else. */
export function sendActionError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ActionError) return reply.code(err.status).send({ error: err.message, ...err.extra });
  throw err;
}

/** The plan-rejection body of `reject`. */
export const rejectBody = z.object({ feedback: z.string().trim().min(1, "feedback is required").max(200_000) });

function fromSandboxError(err: unknown): unknown {
  if (!(err instanceof SandboxError)) return err;
  const exitCode = (err as SandboxError & { exitCode?: number }).exitCode;
  return new ActionError(err.status, err.message, {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(err.output ? { output: lastLines(err.output, 20) } : {}),
  });
}

async function resume(ctx: AppContext, found: FoundRun, planArgs?: string[]): Promise<void> {
  try {
    await resumeRun(ctx, found.ws, found.runId, planArgs ? { planArgs } : {});
  } catch (err) {
    throw fromSandboxError(err);
  }
}

async function fresh(ctx: AppContext, found: FoundRun): Promise<RunObject> {
  return toRunObject(ctx, (await findRun(ctx, found.runId)) ?? found);
}

async function statusOf(ctx: AppContext, found: FoundRun): Promise<RunObject["status"]> {
  return (await toRunObject(ctx, found)).status;
}

async function mustAwaitApproval(ctx: AppContext, found: FoundRun): Promise<void> {
  const status = await statusOf(ctx, found);
  if (status !== "awaiting-approval") throw new ActionError(409, `the run is not awaiting approval (status ${status})`);
}

/** The action in progress per run (`<ws>/<runId>`): approve, reject and resume of one run run one after another. */
const busy = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after any earlier action on the same run has finished, so a second approve or reject sees the status the
 * first one left (409) instead of starting the engine twice.
 */
async function serialized<T>(found: FoundRun, fn: () => Promise<T>): Promise<T> {
  const key = `${found.ws.id}/${found.runId}`;
  const prev = busy.get(key) ?? Promise.resolve();
  const p = prev.catch(() => undefined).then(fn);
  busy.set(key, p);
  try {
    return await p;
  } finally {
    if (busy.get(key) === p) busy.delete(key);
  }
}

/** Approves the plan of an `awaiting-approval` run: the engine resumes with `--approve-plan`. */
export async function approveRun(ctx: AppContext, found: FoundRun): Promise<RunObject> {
  return serialized(found, async () => {
    await mustAwaitApproval(ctx, found);
    await resume(ctx, found, ["--approve-plan"]);
    return fresh(ctx, found);
  });
}

/** Rejects the plan of an `awaiting-approval` run: the feedback goes to a file and the engine plans again (`--replan`). */
export async function rejectRun(ctx: AppContext, found: FoundRun, feedback: string): Promise<RunObject> {
  return serialized(found, async () => {
    await mustAwaitApproval(ctx, found);
    const { ws, runId } = found;
    // A unique name: an earlier feedback file (of a replan that did not start, say) is never overwritten.
    const name = `feedback-${Date.now()}-${randomBytes(3).toString("hex")}.md`;
    const paths = await writeRunInputs(ctx, ws, runId, [{ name, text: feedback }], isSandboxedRun(ctx, ws, runId, found.state));
    await resume(ctx, found, ["--replan", paths[name]!]);
    return fresh(ctx, found);
  });
}

/** Resumes a `failed` (or interrupted) or `aborted` run. */
export async function resumeApiRun(ctx: AppContext, found: FoundRun): Promise<RunObject> {
  return serialized(found, async () => {
    const status = await statusOf(ctx, found);
    if (status !== "failed" && status !== "aborted") throw new ActionError(409, `the run can't be resumed (status ${status})`);
    await resume(ctx, found);
    return fresh(ctx, found);
  });
}

/** Aborts a live run through its page's `POST /abort` (the page's Abort button). */
export async function abortRun(ctx: AppContext, found: FoundRun): Promise<RunObject> {
  const target = await pageTargetOf(runDirOf(found.ws, found.runId));
  if (!target) throw new ActionError(409, "the run is not live");
  let res: { status: number; body: unknown };
  try {
    res = await upstreamPost(target, "/abort", 10_000);
  } catch {
    throw new ActionError(502, "the run's page did not answer");
  }
  if (res.status === 409) {
    const msg = (res.body as { error?: unknown } | undefined)?.error;
    throw new ActionError(409, typeof msg === "string" && msg !== "" ? msg : "the run has ended");
  }
  if (res.status < 200 || res.status >= 300) throw new ActionError(502, "the run's page did not accept the abort");
  return fresh(ctx, found);
}

/** Starts Create PR of an `applied` run with the suggested values. */
export async function startApiRunPr(ctx: AppContext, found: FoundRun): Promise<PrJob> {
  const status = await statusOf(ctx, found);
  if (status !== "applied") throw new ActionError(409, `the run has not landed (status ${status})`);
  try {
    return await startSuggestedPr(ctx, found.ws, found.runId);
  } catch (err) {
    if (err instanceof PrError) throw new ActionError(err.status, err.message);
    throw err;
  }
}

type Params = { Params: { ws: string; runId: string } };

/** The UI's cookie routes for plan approval: the same handlers and answers as /api/v1. */
export async function runActionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const foundOf = async (wsId: string, runId: string): Promise<FoundRun | { error: string; code: number }> => {
    const ws = resolveWorkspace(ctx.config.workspacesDir, wsId);
    if (!ws) return { code: 404, error: "unknown workspace" };
    const { prs, apiRuns } = ctx.store.get();
    const r = isRunId(runId) ? await runSummaryOf(ws, runId, { prs, apiRuns, dataDir: ctx.config.dataDir }) : undefined;
    if (!r) return { code: 404, error: "unknown run" };
    return { ws, runId, ...r };
  };

  app.post<Params>("/api/runs/:ws/:runId/approve", async (req, reply) => {
    const found = await foundOf(req.params.ws, req.params.runId);
    if ("error" in found) return reply.code(found.code).send({ error: found.error });
    try {
      return await approveRun(ctx, found);
    } catch (err) {
      return sendActionError(reply, err);
    }
  });

  app.post<Params>("/api/runs/:ws/:runId/reject", async (req, reply) => {
    const found = await foundOf(req.params.ws, req.params.runId);
    if ("error" in found) return reply.code(found.code).send({ error: found.error });
    const body = rejectBody.parse(req.body ?? {});
    try {
      return await rejectRun(ctx, found, body.feedback);
    } catch (err) {
      return sendActionError(reply, err);
    }
  });
}
