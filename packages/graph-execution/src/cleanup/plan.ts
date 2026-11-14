import { realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { isAncestor, listWorktrees } from "../git/git.js";
import { RUNS_DIR } from "../launch/preflight.js";
import { UsageError } from "../launch/preflight.js";
import { compareIds, type RepoBranches, type RunEntry, type Scan } from "./scan.js";

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
  /** Multi-repo suites: per repo of the project, the suite's branches to delete there. */
  repos?: RepoBranches[];
  /** Why some of the run's branches stay: checked out elsewhere, or unmerged commits. The rest of the entry is still deleted. */
  kept: string[];
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
  const realWorktrees = async (list: { branch?: string; path: string }[]): Promise<{ branch: string; path: string }[]> =>
    Promise.all(list.filter((w) => w.branch !== undefined).map(async (w) => ({ branch: w.branch!, path: await real(w.path) })));
  const checkUnmerged = selected.some((s) => s.run.kind === "unfinished" || s.run.kind === "done") && !opts.force;
  /** Per repo: its worktrees (realpaths) and, when the unmerged check runs, all its branches. Read once per repo. */
  const repoInfo = new Map<string, Promise<{ worktrees: { branch: string; path: string }[]; others: string[] }>>();
  repoInfo.set(
    scan.repo,
    (async () => ({ worktrees: await realWorktrees(scan.worktrees), others: checkUnmerged ? await allBranches(scan.repo) : [] }))(),
  );
  const infoOf = (repo: string): Promise<{ worktrees: { branch: string; path: string }[]; others: string[] }> => {
    let info = repoInfo.get(repo);
    if (!info) {
      info = (async () => ({ worktrees: await realWorktrees(await listWorktrees(repo)), others: checkUnmerged ? await allBranches(repo) : [] }))();
      repoInfo.set(repo, info);
    }
    return info;
  };
  const entries: PlanEntry[] = [];

  /**
   * The branches of `repo` that may go: a branch stays when a worktree outside `dir` (the folder being deleted: execute
   * removes its own worktrees first) holds it, or, with `unmerged`, when no other branch of the repo contains it. Why
   * one stays is pushed to `kept`, prefixed with `label` (a member repo's name).
   */
  const safeBranches = async (
    repo: string,
    branches: string[],
    kept: string[],
    o: { dir?: string; unmerged?: boolean; label?: string },
  ): Promise<string[]> => {
    if (branches.length === 0) return [];
    const prefix = o.label ? `${o.label}: ` : "";
    const info = await infoOf(repo);
    const own = o.dir ? await real(o.dir) : undefined;
    const held = new Set(info.worktrees.filter((w) => !own || !(w.path === own || w.path.startsWith(own + path.sep))).map((w) => w.branch));
    const out = branches.filter((b) => held.has(b));
    if (out.length > 0) kept.push(`${prefix}checked out: ${out.join(", ")}`);
    let left = branches.filter((b) => !held.has(b));
    if (o.unmerged) {
      const mine = new Set(branches);
      const outside = info.others.filter((b) => !mine.has(b));
      const unmerged: string[] = [];
      for (const b of left) {
        let merged = false;
        for (const x of outside) {
          if (await isAncestor(repo, b, x)) {
            merged = true;
            break;
          }
        }
        if (!merged) unmerged.push(b);
      }
      if (unmerged.length > 0) {
        kept.push(`${prefix}unmerged commits (use --force): ${unmerged.join(", ")}`);
        left = left.filter((b) => !unmerged.includes(b));
      }
    }
    return left;
  };

  for (const { run, reason } of selected) {
    const kept: string[] = [];
    const unmerged = (run.kind === "unfinished" || run.kind === "done") && !opts.force;
    const branches = await safeBranches(scan.repo, run.branches, kept, { dir: run.dir, unmerged });
    let repos: RepoBranches[] | undefined;
    if (run.repos) {
      repos = [];
      for (const r of run.repos) {
        repos.push({ name: r.name, path: r.path, branches: await safeBranches(r.path, r.branches, kept, { dir: run.dir, unmerged, label: r.name }) });
      }
    }
    entries.push({ kind: run.type, id: run.id, reason, dir: run.dir, branches, kept, sizeBytes: run.sizeBytes, ...(repos ? { repos } : {}) });
  }

  if (opts.runId === undefined && !opts.retentionOnly) {
    const kept: string[] = [];
    const branches = await safeBranches(scan.repo, scan.orphans, kept, {});
    if (branches.length > 0) entries.push({ kind: "orphans", id: "orphans", reason: "no run folder", branches, kept, sizeBytes: 0 });
    else for (const k of kept) skipped.push({ id: "orphans", reason: k });
  }

  return { entries, skipped, totalBytes: entries.reduce((a, e) => a + e.sizeBytes, 0) };
}
