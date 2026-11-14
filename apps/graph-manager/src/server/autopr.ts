/**
 * The auto-PR loop (docs/prd/automation-api.md): an API run started with `openPr: true` gets its pull request once it
 * is `applied`, without a click. Create PR is tried once per run; a failure is kept as `prError` and never retried.
 */
import { existsSync } from "node:fs";
import type { AppContext } from "./app.js";
import { currentJob, startSuggestedPr } from "./pr.js";
import { readRunStateOf, runDirOf } from "./runs.js";
import { resolveWorkspace } from "./workspaces.js";

export const AUTO_PR_MS = 15_000;

async function savePrError(ctx: AppContext, key: string, message: string): Promise<void> {
  await ctx.store.update((d) => {
    const r = d.apiRuns[key];
    if (r) r.prError = message;
  });
}

/**
 * One pass of the auto-PR loop: for each apiRuns entry with openPr, no stored PR and no earlier attempt whose run is
 * `applied`, mark it attempted and start Create PR with the suggested values. A refusal, or a job that ended failed,
 * is saved as `prError` and logged; it is never tried again by the loop.
 */
export async function autoPrTick(ctx: AppContext, log: (msg: string) => void = console.warn): Promise<void> {
  const data = ctx.store.get();
  for (const [key, rec] of Object.entries(data.apiRuns)) {
    if (!rec.openPr || rec.prSkipped !== undefined || ctx.store.get().prs[key]) continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const ws = resolveWorkspace(ctx.config.workspacesDir, key.slice(0, slash));
    if (!ws) continue;
    const runId = key.slice(slash + 1);
    try {
      if (rec.prAttempted) {
        const job = currentJob(ctx, ws, runId);
        if (!rec.prError && job?.status === "failed") {
          const message = job.error ?? "Create PR failed";
          await savePrError(ctx, key, message);
          log(`auto PR for ${key} failed: ${message}`);
        }
        continue;
      }
      const state = await readRunStateOf(ws, runId);
      // A run that can never become applied (needs-info and done are final) or whose folder was deleted is not read
      // again on later ticks. failed and aborted runs can still be resumed, so they stay.
      const skip =
        state === undefined
          ? existsSync(runDirOf(ws, runId))
            ? undefined
            : "the run folder is gone"
          : state.status === "needs-info" || state.status === "done"
            ? `the run ended ${state.status}`
            : undefined;
      if (skip !== undefined) {
        await ctx.store.update((d) => {
          const r = d.apiRuns[key];
          if (r) r.prSkipped = skip;
        });
        continue;
      }
      if (state?.status !== "applied") continue;
      await ctx.store.update((d) => {
        const r = d.apiRuns[key];
        if (r) r.prAttempted = true;
      });
      try {
        await startSuggestedPr(ctx, ws, runId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await savePrError(ctx, key, message);
        log(`auto PR for ${key} failed: ${message}`);
      }
    } catch (err) {
      // A store write failed: try the entry again on the next tick.
      log(`auto PR for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Runs autoPrTick every `ms` (unref'd timer; ticks never overlap). Returns stop(). */
export function startAutoPr(ctx: AppContext, ms = AUTO_PR_MS, log?: (msg: string) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async (): Promise<void> => {
    try {
      await autoPrTick(ctx, log);
    } catch {
      // autoPrTick logs per entry; never let the loop die.
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), ms);
    timer.unref();
  };
  void loop();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
