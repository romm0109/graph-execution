import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { deleteBranchIfPresent, pruneWorktrees, removeWorktreeIfPresent } from "../git/git.js";
import { formatSize } from "./format.js";
import type { CleanPlan } from "./plan.js";

/** Removes what the plan lists: worktrees, branches, run folders. A failure is counted and the rest goes on. */
export async function execute(repo: string, plan: CleanPlan, log: (l: string) => void): Promise<{ failed: number }> {
  let failed = 0;
  for (const entry of plan.entries) {
    let broken = false;
    try {
      if (entry.kind !== "orphans" && entry.dir) {
        const dirs = [path.join(entry.dir, "worktrees")];
        if (entry.kind === "suite") {
          const featuresDir = path.join(entry.dir, "features");
          for (const f of await readdir(featuresDir).catch(() => [])) dirs.push(path.join(featuresDir, f, "worktrees"));
        }
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
    else log(`deleted ${entry.id} (${formatSize(entry.sizeBytes)})`);
  }
  await pruneWorktrees(repo);
  return { failed };
}
