import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { deleteBranchIfPresent, pruneWorktrees, removeWorktreeIfPresent } from "../git/git.js";
import { reapOrphans } from "../state/processes.js";
import { formatSize } from "./format.js";
import type { CleanPlan } from "./plan.js";

/** Removes what the plan lists: worktrees, branches, run folders. A failure is counted and the rest goes on. */
export async function execute(repo: string, plan: CleanPlan, log: (l: string) => void): Promise<{ failed: number }> {
  let failed = 0;
  for (const entry of plan.entries) {
    let broken = false;
    try {
      if (entry.kind !== "orphans" && entry.dir) {
        const runDirs = [entry.dir];
        if (entry.kind === "suite") {
          const featuresDir = path.join(entry.dir, "features");
          for (const f of await readdir(featuresDir).catch(() => [])) runDirs.push(path.join(featuresDir, f));
        }
        const dirs = runDirs.map((d) => path.join(d, "worktrees"));
        // Agents a killed CLI left running are stopped before their worktrees go.
        for (const d of runDirs) await reapOrphans(d, { log });
        await pruneWorktrees(repo);
        for (const worktreesDir of dirs) {
          for (const name of await readdir(worktreesDir).catch(() => [])) {
            await removeWorktreeIfPresent(repo, path.join(worktreesDir, name));
          }
        }
      }
      for (const b of entry.branches) await deleteBranchIfPresent(repo, b);
      if (entry.kind !== "orphans" && entry.dir) await rm(entry.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      broken = true;
      log(`failed ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (broken) failed++;
    else log(`deleted ${entry.id} (${formatSize(entry.sizeBytes)})${entry.kept.length > 0 ? `; kept branches ${entry.kept.join("; ")}` : ""}`);
  }
  await pruneWorktrees(repo);
  return { failed };
}
