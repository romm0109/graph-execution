import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { isActive } from "../hosted-runs.js";
import { PrError, currentJob, prStatus, startPr, type PrRef, type PrStatus, type PrStatusWithJob } from "../pr.js";
import { prKeyOf, projectPrStatus, startProjectPr, type ProjectPrStatus } from "../project-pr.js";
import { PROJECT_PREFIX } from "../runhome.js";
import type { HostedRunRecord, UserStore } from "../store.js";
import { resolveRunHome } from "../runhome.js";
import { isRunId } from "../runs.js";

const createBody = z.object({
  branch: z.string().trim().min(1, "branch is required"),
  title: z.string().trim().min(1, "title is required"),
  body: z.string().default(""),
  base: z.string().trim().optional(),
});

type Params = { Params: { ws: string; runId: string } };

/** A project run whose PR could not be opened for every changed repository. */
const projectRetryable = (rec: HostedRunRecord): boolean => (rec.repos ?? []).some((r) => r.pushed && !r.prUrl);

/** The PR panel's status of a hosted run (its PR is opened by the run monitor; Create PR only retries a failed one). */
function hostedPrStatus(us: UserStore, rec: HostedRunRecord): PrStatus | ProjectPrStatus {
  const prs = us.get().prs;
  if (rec.repos) {
    const projectId = rec.workspaceId.slice(PROJECT_PREFIX.length);
    const repos = rec.repos.map((r) => {
      const stored = prs[prKeyOf(projectId, rec.runId, r.name)];
      return {
        name: r.name,
        fullPath: r.fullPath,
        changed: r.pushed && !stored,
        ...(stored ? { pr: { url: stored.url, number: stored.number, branch: stored.branch, ...(stored.base ? { base: stored.base } : {}) } } : {}),
        ...(stored?.linked ? { linked: true } : {}),
        ...(r.error ? { error: r.error } : {}),
      };
    });
    const eligible = !isActive(rec) && projectRetryable(rec);
    const forge = us.get().projects[projectId]?.repos[0]?.forge;
    return { project: true, ...(forge ? { forge } : {}), eligible, ...(rec.prError ? { reason: rec.prError } : {}), repos };
  }
  const stored = prs[`${rec.workspaceId}/${rec.runId}`];
  if (stored) {
    const pr: PrRef = { url: stored.url, number: stored.number, branch: stored.branch, ...(stored.base ? { base: stored.base } : {}) };
    return { pr, eligible: false };
  }
  if (isActive(rec)) return { eligible: false, reason: "the run is still running: its pull request opens when it lands" };
  if (rec.prError) {
    const title = rec.prTitle ?? `graph-execution run ${rec.runId}`;
    return {
      eligible: true,
      reason: rec.prError,
      suggested: { branch: `gm/${rec.runId}`, title, body: rec.prBody ?? "", base: rec.branch, bases: [rec.branch] },
    };
  }
  return { eligible: false, reason: rec.error ?? "the run did not land" };
}

export async function prRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<Params>("/api/runs/:ws/:runId/pr", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const us = await ctx.store.forUser(req.user);
    const hosted = await ctx.hostedRuns.recordOf(req.user, req.params.ws, req.params.runId);
    if (hosted) return hostedPrStatus(us, hosted);
    const home = resolveRunHome(ctx.config.workspacesDir, us, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    if (home.kind === "project") {
      // One PR per changed repo (MR-09); the status carries the latest job of the run.
      const status = await projectPrStatus(ctx, us, home, req.params.runId);
      if (!status) return reply.code(404).send({ error: "unknown run" });
      return status;
    }
    const ws = home.workspace;
    const status = await prStatus(ctx, us, await ctx.hostFor(ws.id, req.user), ws, req.params.runId);
    if (!status) return reply.code(404).send({ error: "unknown run" });
    const job = currentJob(ctx, ws, req.params.runId);
    const res: PrStatusWithJob = job ? { ...status, job } : status;
    return res;
  });

  app.post<Params>("/api/runs/:ws/:runId/pr", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const us = await ctx.store.forUser(req.user);
    // A hosted run whose PR failed (its container is gone): only the forge call again, from the pushed gm/<runId>.
    const hosted = await ctx.hostedRuns.recordOf(req.user, req.params.ws, req.params.runId);
    if (hosted) {
      if (isActive(hosted)) return reply.code(409).send({ error: "the run is still running: its pull request opens when it lands" });
      const retryable = hosted.repos ? projectRetryable(hosted) : hosted.prError !== undefined && hosted.prUrl === undefined;
      if (!retryable) return reply.code(409).send({ error: hosted.prUrl ? "a pull request already exists for this run" : (hosted.error ?? "the run did not land") });
      try {
        const job = await ctx.hostedRuns.retryPr(req.user, hosted);
        return reply.code(202).send({ job });
      } catch (err) {
        if (err instanceof PrError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    }
    const home = resolveRunHome(ctx.config.workspacesDir, us, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    if (home.kind === "project") {
      try {
        const job = await startProjectPr(ctx, us, home, req.params.runId);
        return reply.code(202).send({ job });
      } catch (err) {
        if (err instanceof PrError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    }
    const ws = home.workspace;
    const body = createBody.parse(req.body ?? {});
    try {
      const job = await startPr(ctx, us, await ctx.hostFor(ws.id, req.user), ws, req.params.runId, body);
      return reply.code(202).send({ job });
    } catch (err) {
      if (err instanceof PrError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
