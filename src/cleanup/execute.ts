import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { deleteBranchIfPresent, isRepo, pruneWorktrees, removeWorktreeIfPresent } from "../git/git.js";
import { formatSize } from "./format.js";
import type { CleanPlan } from "./plan.js";

/** Removes what the plan lists: worktrees, branches, run folders. A failure is counted and the rest goes on. */
export async function execute(home: string, plan: CleanPlan, log: (l: string) => void): Promise<{ failed: number }> {
  let failed = 0;
  for (const entry of plan.entries) {
    let broken = false;
    const homeIsRepo = await isRepo(home);
    try {
      for (const r of entry.repos ?? []) {
        if (r.missing || !(await isRepo(r.root))) {
          log(`${entry.id}: repo ${r.root} not found; skipped`);
          continue;
        }
        await pruneWorktrees(r.root);
        for (const w of r.worktrees) await removeWorktreeIfPresent(r.root, w);
        for (const b of r.branches) await deleteBranchIfPresent(r.root, b);
        await rm(path.join(r.root, ".graph-execution", "_suites", `${entry.id}.json`), { force: true });
      }
      if (entry.kind !== "orphans" && entry.dir) {
        const dirs = [path.join(entry.dir, "worktrees")];
        if (entry.kind === "suite") {
          const featuresDir = path.join(entry.dir, "features");
          for (const f of await readdir(featuresDir).catch(() => [])) dirs.push(path.join(featuresDir, f, "worktrees"));
        }
        if (homeIsRepo) await pruneWorktrees(home);
        for (const worktreesDir of dirs) {
          for (const name of await readdir(worktreesDir).catch(() => [])) {
            if (homeIsRepo) await removeWorktreeIfPresent(home, path.join(worktreesDir, name));
          }
        }
      }
      if (homeIsRepo) for (const b of entry.branches) await deleteBranchIfPresent(home, b);
      if (entry.kind !== "orphans" && entry.dir) await rm(entry.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      broken = true;
      log(`failed ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (broken) failed++;
    else log(`deleted ${entry.id} (${formatSize(entry.sizeBytes)})`);
  }
  if (await isRepo(home)) await pruneWorktrees(home);
  return { failed };
}
