/**
 * The run object of the /api/v1 automation API (docs/prd/automation-api.md): one run of a workspace mapped to the
 * JSON shape clients see. Suites are not part of v1.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { planSpecRel, planTasksRel, type RunState } from "graph-execution/api";
import type { AppContext } from "./app.js";
import { detailUrlOf, listWorkspaceRuns, readRunStateOf, runDirOf, runSummaryOf, type RunSummary } from "./runs.js";
import { readCachedView } from "./viewcache.js";
import { listWorkspaces, type Workspace } from "./workspaces.js";

export const V1_STATUSES = ["planning", "needs-info", "awaiting-approval", "running", "applied", "done", "failed", "aborted"] as const;
export type V1Status = (typeof V1_STATUSES)[number];

export interface RunRef {
  ref: string;
  url?: string;
  title?: string;
}

export interface RunObject {
  runId: string;
  workspace: string;
  status: V1Status;
  refs: RunRef[];
  questions: { ref?: string; questions: string[] }[];
  dropped: string[];
  spec?: string;
  tasksDir?: string;
  viewUrl: string;
  pr?: { url: string; number: number };
  error?: string;
  /** Why the auto PR (`openPr`) failed; the loop does not try again. */
  prError?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FoundRun {
  ws: Workspace;
  runId: string;
  summary: RunSummary;
  state?: RunState;
}

const isV1Status = (s: string): s is V1Status => (V1_STATUSES as readonly string[]).includes(s);

/**
 * The v1 status of a run. A run whose process is gone (`interrupted`) is `failed`: v1 has no `interrupted`, and a
 * failed run can be resumed. Anything unknown is `failed` too.
 */
export function v1StatusOf(summary: RunSummary): V1Status {
  return isV1Status(summary.status) ? summary.status : "failed";
}

/** The run with this id in any workspace (first match; run ids carry a timestamp and random hex). Suites: undefined. */
export async function findRun(ctx: AppContext, runId: string): Promise<FoundRun | undefined> {
  const { prs, apiRuns } = ctx.store.get();
  const extras = { prs, apiRuns, dataDir: ctx.config.dataDir };
  for (const ws of await listWorkspaces(ctx.config.workspacesDir)) {
    if (!existsSync(runDirOf(ws, runId))) continue;
    const r = await runSummaryOf(ws, runId, extras);
    if (r) return { ws, runId, ...r };
  }
  return undefined;
}

/** Every run (no suites) of one workspace or of all, newest first. */
export async function listFoundRuns(ctx: AppContext, ws?: Workspace): Promise<FoundRun[]> {
  const { prs, apiRuns } = ctx.store.get();
  const workspaces = ws ? [ws] : await listWorkspaces(ctx.config.workspacesDir);
  const found = (
    await Promise.all(
      workspaces.map(async (w) => {
        const summaries = (await listWorkspaceRuns(w, prs, ctx.config.dataDir, apiRuns)).filter((s) => s.type === "run");
        return Promise.all(
          summaries.map(async (summary): Promise<FoundRun> => {
            const state = await readRunStateOf(w, summary.id);
            return state ? { ws: w, runId: summary.id, summary, state } : { ws: w, runId: summary.id, summary };
          }),
        );
      }),
    )
  ).flat();
  return found.sort(
    (a, b) => (b.summary.createdAt ?? "").localeCompare(a.summary.createdAt ?? "") || b.runId.localeCompare(a.runId),
  );
}

/** `p` relative to the workspace with "/" separators; undefined when it is outside it. */
function relToWorkspace(ws: Workspace, p: string | undefined): string | undefined {
  if (!p) return undefined;
  const rel = path.relative(ws.path, p);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

async function errorOf(ctx: AppContext, run: FoundRun): Promise<string> {
  const { summary, state } = run;
  if (state?.plan?.error) return `planning failed: ${state.plan.error}`;
  if (summary.status === "interrupted") return "interrupted: the run's process is gone";
  const view = await readCachedView(ctx.config.dataDir, run.ws.id, run.runId);
  const abort = view?.summary?.abort;
  if (abort) return `${abort.step} failed: ${abort.message}`;
  return summary.failure ?? "failed";
}

async function updatedAtOf(run: FoundRun): Promise<string | undefined> {
  try {
    return (await stat(path.join(runDirOf(run.ws, run.runId), "state.json"))).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export async function toRunObject(ctx: AppContext, run: FoundRun): Promise<RunObject> {
  const { ws, runId, summary, state } = run;
  const status = v1StatusOf(summary);
  const plan = state?.plan;
  const apiRun = ctx.store.get().apiRuns[`${ws.id}/${runId}`];
  const apiRefs = apiRun?.refs;
  const obj: RunObject = {
    runId,
    workspace: ws.id,
    status,
    refs: apiRefs?.length ? apiRefs : (plan?.refs ?? []),
    questions: plan?.questions ?? [],
    dropped: plan?.dropped ?? [],
    viewUrl: detailUrlOf(ws.id, runId),
  };
  // Before apply, the planned files exist only on the integration branch: name their repo paths, not state's paths.
  const spec = plan?.name ? planSpecRel(plan.name) : relToWorkspace(ws, state?.specPath);
  const tasksDir = plan?.name ? planTasksRel(plan.name) : relToWorkspace(ws, state?.tasksDir);
  if (spec !== undefined) obj.spec = spec;
  if (tasksDir !== undefined) obj.tasksDir = tasksDir;
  const pr = ctx.store.get().prs[`${ws.id}/${runId}`];
  if (pr) obj.pr = { url: pr.url, number: pr.number };
  if (status === "failed") obj.error = await errorOf(ctx, run);
  if (apiRun?.prError !== undefined && !pr) obj.prError = apiRun.prError;
  const createdAt = state?.createdAt ?? summary.createdAt;
  if (createdAt !== undefined) obj.createdAt = createdAt;
  const updatedAt = await updatedAtOf(run);
  if (updatedAt !== undefined) obj.updatedAt = updatedAt;
  return obj;
}
