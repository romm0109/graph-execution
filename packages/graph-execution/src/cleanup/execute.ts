import { readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { deleteBranchIfPresent, listWorktrees, pruneWorktrees, removeWorktreeIfPresent } from "../git/git.js";
import { reapOrphans } from "../state/processes.js";
import { formatSize } from "./format.js";
import { pruneProjectLinks, unlinkProjectSuite } from "./links.js";
import type { CleanPlan } from "./plan.js";

const real = async (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));

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
        // A multi-repo suite: every worktree under its folder belongs to one of the project's repos.
        if (entry.repos) {
          const own = await real(entry.dir);
          for (const r of entry.repos) {
            await pruneWorktrees(r.path).catch(() => {});
            for (const w of await listWorktrees(r.path)) {
              const p = await real(w.path);
              if (p === own || p.startsWith(own + path.sep)) await removeWorktreeIfPresent(r.path, w.path);
            }
            for (const b of r.branches) await deleteBranchIfPresent(r.path, b);
          }
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
      for (const r of entry.repos ?? []) {
        // A repo that is gone has nothing to prune: the folder is removed, so the entry still counts as deleted.
        await pruneWorktrees(r.path).catch(() => {});
        await unlinkProjectSuite(r.path, entry.id).catch(() => {});
      }
    } catch (err) {
      broken = true;
      log(`failed ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (broken) failed++;
    else log(`deleted ${entry.id} (${formatSize(entry.sizeBytes)})${entry.kept.length > 0 ? `; kept branches ${entry.kept.join("; ")}` : ""}`);
  }
  await pruneWorktrees(repo);
  await pruneProjectLinks(repo).catch(() => {});
  return { failed };
}
