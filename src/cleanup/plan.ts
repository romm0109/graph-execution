import { realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { isAncestor } from "../git/git.js";
import { RUNS_DIR } from "../launch/preflight.js";
import { UsageError } from "../launch/preflight.js";
import { compareIds, type RunEntry, type Scan } from "./scan.js";

export interface PlanOptions {
  keepRuns: number; // 0 = no retention
  runId?: string; // clean <run-id>: only that run
  includeDone?: boolean; // --done
  retentionOnly?: boolean; // automatic retention at run start: only applied runs beyond keepRuns
  force?: boolean;
}

export interface PlanEntry {
  kind: "run" | "suite" | "orphans";
  id: string;
  reason: string;
  dir?: string;
  branches: string[];
  /** Suites only: the other repos' share, see `RunEntry.repos`. */
  repos?: RunEntry["repos"];
  sizeBytes: number;
}

export interface Skip {
  id: string;
  reason: string;
}

export interface CleanPlan {
  entries: PlanEntry[];
  skipped: Skip[];
  totalBytes: number;
}

async function allBranches(repo: string): Promise<string[]> {
  const res = await execa("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: repo, reject: false });
  return res.exitCode === 0 ? res.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** Which runs to delete, and why not the others. Reads git to check branch safety; changes nothing. */
export async function plan(scan: Scan, opts: PlanOptions): Promise<CleanPlan> {
  const skipped: Skip[] = [];
  const selected: { run: RunEntry; reason: string }[] = [];

  if (opts.runId !== undefined) {
    const run = scan.runs.find((r) => r.id === opts.runId);
    if (!run) throw new UsageError(`no run ${opts.runId} in ${scan.repo}/${RUNS_DIR}`);
    if (run.kind === "live") skipped.push({ id: run.id, reason: `running (pid ${run.pid})` });
    else selected.push({ run, reason: run.kind === "applied" ? "requested" : run.kind === "done" ? "finished without apply" : "unfinished" });
  } else {
    for (const run of scan.runs) {
      if (run.kind === "live") skipped.push({ id: run.id, reason: `running (pid ${run.pid})` });
    }
    const applied = scan.runs.filter((r) => r.kind === "applied").sort((a, b) => compareIds(a.id, b.id));
    const old = opts.keepRuns === 0 ? [] : applied.slice(0, Math.max(0, applied.length - opts.keepRuns));
    for (const run of old) selected.push({ run, reason: `older than the newest ${opts.keepRuns} applied runs` });
    if (!opts.retentionOnly) {
      for (const run of scan.runs) {
        if (run.kind === "unfinished") selected.push({ run, reason: "unfinished" });
        else if (run.kind === "done" && opts.includeDone) selected.push({ run, reason: "finished without apply" });
      }
      selected.sort((a, b) => compareIds(a.run.id, b.run.id));
    }
  }

  const real = async (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));
  const worktrees = await Promise.all(scan.worktrees.map(async (w) => ({ branch: w.branch, path: await real(w.path) })));
  const others = selected.some((s) => s.run.kind === "unfinished" || s.run.kind === "done") && !opts.force ? await allBranches(scan.repo) : [];
  const entries: PlanEntry[] = [];

  /** A branch is checked out when a worktree outside the folder being deleted holds it: execute removes the folder's own worktrees first. */
  const dropCheckedOut = async (id: string, branches: string[], dir?: string): Promise<string[]> => {
    const own = dir ? await real(dir) : undefined;
    const held = new Set(worktrees.filter((w) => !own || !(w.path === own || w.path.startsWith(own + path.sep))).map((w) => w.branch));
    const kept = branches.filter((b) => held.has(b));
    if (kept.length > 0) skipped.push({ id, reason: `checked out: ${kept.join(", ")}` });
    return branches.filter((b) => !held.has(b));
  };

  for (const { run, reason } of selected) {
    let branches = await dropCheckedOut(run.id, run.branches, run.dir);
    if ((run.kind === "unfinished" || run.kind === "done") && !opts.force) {
      const own = new Set(run.branches);
      const outside = others.filter((b) => !own.has(b));
      const unmerged: string[] = [];
      for (const b of branches) {
        let merged = false;
        for (const o of outside) {
          if (await isAncestor(scan.repo, b, o)) {
            merged = true;
            break;
          }
        }
        if (!merged) unmerged.push(b);
      }
      if (unmerged.length > 0) {
        skipped.push({ id: run.id, reason: `has unmerged commits (use --force): ${unmerged.join(", ")} kept` });
        branches = branches.filter((b) => !unmerged.includes(b));
      }
    }
    entries.push({ kind: run.type, id: run.id, reason, dir: run.dir, branches, ...(run.repos ? { repos: run.repos } : {}), sizeBytes: run.sizeBytes });
  }

  if (opts.runId === undefined && !opts.retentionOnly) {
    const branches = await dropCheckedOut("orphans", scan.orphans);
    if (branches.length > 0) entries.push({ kind: "orphans", id: "orphans", reason: "no run folder", branches, sizeBytes: 0 });
  }

  return { entries, skipped, totalBytes: entries.reduce((a, e) => a + e.sizeBytes, 0) };
}
