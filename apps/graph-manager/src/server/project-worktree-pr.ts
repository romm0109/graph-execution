// Create PR for a project terminal (docs/prd/project-terminal-worktrees.md): one PR per repo whose worktree holds work,
// each from `gm-term/<wid>` into that repo's base branch, with the bodies linked to each other. The project repo is
// never pushed. Once every PR is open the repo worktrees go (their branches stay) and the terminal closes.
import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "./app.js";
import { FORGE_NAMES, clientFor, connFor, type ForgeKind } from "./forges.js";
import { PrError, scrub } from "./pr.js";
import { relatedSection, withRelated, type ProjectPrJob, type ProjectPrJobRepo } from "./project-pr.js";
import { projectDirOf } from "./projects.js";
import type { ProjectWorktreeRecord } from "./store.js";
import { resolveWorkspace, type Workspace } from "./workspaces.js";
import { PrStepError, pushAndOpenPr } from "./worktree-pr.js";
import { hasWork, projectWorktreeState, removeWorktree } from "./worktrees.js";

export interface ProjectWorktreePrInput {
  title?: string;
  body?: string;
  /** The branch each repo's PR merges into, by repo name; default: the repo's `baseBranch`. */
  bases?: Record<string, string>;
  retry?: boolean;
}

/** The store key of one repo's PR of a project terminal. */
export const projectWorktreePrKey = (projectId: string, wid: string, repo: string): string => `${projectId}/term-${wid}/${repo}`;

const jobKey = (projectId: string, wid: string): string => `${projectId}/term-${wid}`;

interface Registry {
  jobs: Map<string, ProjectPrJob>;
  /** What the last job was asked, for a Retry that sends nothing else. */
  inputs: Map<string, { title: string; body: string; bases: Record<string, string> }>;
  starting: Set<string>;
}
const registries = new WeakMap<AppContext, Registry>();
function registry(ctx: AppContext): Registry {
  let r = registries.get(ctx);
  if (!r) {
    r = { jobs: new Map(), inputs: new Map(), starting: new Set() };
    registries.set(ctx, r);
  }
  return r;
}

export function currentProjectWorktreeJob(ctx: AppContext, projectId: string, wid: string): ProjectPrJob | undefined {
  return registry(ctx).jobs.get(jobKey(projectId, wid));
}

const isForge = (f: string): f is ForgeKind => f === "github" || f === "gitlab";

interface Participant {
  name: string;
  ws: Workspace & { forge: ForgeKind };
  path: string;
  branch: string;
  base: string;
}

/** Checks, then starts the job in the background. Throws `PrError`. */
export async function startProjectWorktreePr(
  ctx: AppContext,
  projectId: string,
  wid: string,
  rec: ProjectWorktreeRecord,
  given: ProjectWorktreePrInput,
): Promise<ProjectPrJob> {
  const reg = registry(ctx);
  const key = jobKey(projectId, wid);
  const last = reg.jobs.get(key);
  if (last?.status === "running" || reg.starting.has(key)) throw new PrError(409, "pull requests are already being created");
  if (given.retry && last?.status !== "failed") throw new PrError(409, "no failed Create PR to retry");
  reg.starting.add(key);
  try {
    const root = path.resolve(ctx.config.workspacesDir);
    const prev = given.retry ? reg.inputs.get(key) : undefined;
    const title = (given.title?.trim() || prev?.title || rec.title).trim();
    const body = given.body ?? prev?.body ?? "";
    const bases = { ...(prev?.bases ?? {}), ...(given.bases ?? {}) };
    const state = await projectWorktreeState(rec);
    const prs = ctx.store.get().prs;

    const participants: Participant[] = [];
    const entries: ProjectPrJobRepo[] = [];
    for (const repo of rec.repos) {
      const steps = (["access", "commit", "push", "create"] as const).map((name) => ({ name, state: "pending" as const }));
      const entry: ProjectPrJobRepo = { name: repo.name, status: "pending", steps };
      entries.push(entry);
      const stored = prs[projectWorktreePrKey(projectId, wid, repo.name)];
      const s = state.repos.find((r) => r.name === repo.name);
      const work = repo.isolated && s !== undefined && hasWork(s);
      if (!repo.isolated || (!stored && !work) || repo.branch === undefined) {
        entry.status = "skipped";
        continue;
      }
      const ws = repo.workspaceId !== undefined ? resolveWorkspace(root, repo.workspaceId) : undefined;
      if (stored) {
        entry.pr = { url: stored.url, number: stored.number, branch: stored.branch };
        for (const st of entry.steps) Object.assign(st, { state: "done", detail: "already open" });
        entry.status = "skipped";
      }
      if (!ws) {
        if (!stored) {
          entry.status = "failed";
          entry.error = "the repo's workspace is missing";
        }
        continue;
      }
      if (!isForge(ws.forge)) {
        if (!stored) {
          entry.status = "failed";
          entry.error = `${ws.forge} is not a supported forge`;
        }
        continue;
      }
      participants.push({ name: repo.name, ws: ws as Workspace & { forge: ForgeKind }, path: repo.path, branch: repo.branch, base: bases[repo.name]?.trim() || repo.baseBranch || "" });
    }
    if (participants.length === 0 && !entries.some((e) => e.status === "failed")) throw new PrError(409, "no repo has changes");
    const first = participants[0];
    if (first && !connFor(ctx, first.ws.forge)) throw new PrError(409, `${FORGE_NAMES[first.ws.forge]} is not connected`);
    for (const p of participants) {
      if (p.base !== "") continue;
      try {
        p.base = (await clientFor(ctx, p.ws.forge).getRepo(p.ws.fullPath)).defaultBranch;
      } catch {
        p.base = "main";
      }
    }

    const job: ProjectPrJob = { id: randomUUID(), status: "running", startedAt: new Date().toISOString(), repos: entries, link: { state: "pending" } };
    reg.jobs.set(key, job);
    reg.inputs.set(key, { title, body, bases });
    void runProjectWorktreePrJob(job, ctx, projectId, wid, rec, participants, { title, body });
    return job;
  } finally {
    reg.starting.delete(key);
  }
}

/** Removes the `repos/<name>` link of the project worktree, never following it. */
async function unlinkRepo(dir: string, name: string): Promise<void> {
  const link = path.join(dir, "repos", name);
  try {
    if ((await lstat(link)).isSymbolicLink()) await rm(link);
  } catch {
    // missing
  }
}

/** Opens the missing PRs repo by repo, links the bodies, then cleans up on full success. Never throws. */
async function runProjectWorktreePrJob(
  job: ProjectPrJob,
  ctx: AppContext,
  projectId: string,
  wid: string,
  rec: ProjectWorktreeRecord,
  participants: Participant[],
  p: { title: string; body: string },
): Promise<void> {
  const tokens = new Set<string>();
  const scrubAll = (text: string): string => [...tokens].reduce((t, tok) => scrub(t, tok), text);
  const storedOf = (name: string) => ctx.store.get().prs[projectWorktreePrKey(projectId, wid, name)];
  try {
    for (const part of participants) {
      const jr = job.repos.find((r) => r.name === part.name)!;
      if (storedOf(part.name)) continue;
      const conn = connFor(ctx, part.ws.forge);
      if (!conn) {
        jr.status = "failed";
        jr.error = `${FORGE_NAMES[part.ws.forge]} is not connected`;
        continue;
      }
      tokens.add(conn.token);
      jr.status = "running";
      try {
        const pr = await pushAndOpenPr(
          ctx,
          part.ws,
          { path: part.path, branch: part.branch },
          { forge: part.ws.forge, token: conn.token, title: p.title, body: p.body, base: part.base },
          jr.steps,
        );
        await ctx.store.update((d) => {
          d.prs[projectWorktreePrKey(projectId, wid, part.name)] = {
            url: pr.url,
            number: pr.number,
            branch: part.branch,
            base: part.base,
            forge: part.ws.forge,
            createdAt: new Date().toISOString(),
          };
        });
        jr.pr = { url: pr.url, number: pr.number, branch: part.branch };
        jr.status = "done";
      } catch (err) {
        jr.error = err instanceof PrStepError ? err.message : scrub((err as Error)?.message ?? String(err), conn.token);
        jr.status = "failed";
      }
    }

    const allOpen = participants.length > 0 && participants.every((x) => storedOf(x.name) !== undefined) && !job.repos.some((r) => r.status === "failed");
    if (allOpen) {
      job.link = { state: "running" };
      const others = participants.map((x) => {
        const s = storedOf(x.name)!;
        return { name: x.name, fullPath: x.ws.fullPath, number: s.number, url: s.url };
      });
      const failures: string[] = [];
      for (const x of participants) {
        const key = projectWorktreePrKey(projectId, wid, x.name);
        const stored = storedOf(x.name)!;
        if (participants.length > 1) {
          try {
            await clientFor(ctx, stored.forge).updatePullRequest({
              fullPath: x.ws.fullPath,
              number: stored.number,
              body: withRelated(p.body, relatedSection(x.name, others)),
            });
          } catch (err) {
            failures.push(`${x.name}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        await ctx.store.update((d) => {
          const r = d.prs[key];
          if (r) r.linked = true;
        });
      }
      job.link = failures.length === 0 ? { state: "done" } : { state: "failed", detail: scrubAll(failures.join("; ")) };
    } else {
      job.link = { state: "pending", detail: "waiting for every pull request" };
    }

    const failed = job.repos.filter((r) => r.status === "failed");
    if (failed.length === 0 && job.link.state === "done") {
      await cleanUp(ctx, projectId, wid, rec);
      job.status = "done";
    } else {
      const errors = failed.map((r) => `${r.name}: ${r.error ?? "failed"}`);
      if (job.link.state === "failed") errors.push(`linking failed: ${job.link.detail ?? "unknown error"}`);
      job.error = scrubAll(errors.join("; ") || "not every pull request could be opened");
      job.status = "failed";
    }
  } catch (err) {
    job.error = scrubAll(err instanceof Error ? err.message : String(err));
    job.status = "failed";
  }
}

/**
 * Every PR is open: the terminal closes and each repo worktree goes, its `gm-term/<wid>` branch stays. The project-repo
 * worktree stays kept when it still holds work; otherwise it goes with its branch and the record.
 */
async function cleanUp(ctx: AppContext, projectId: string, wid: string, rec: ProjectWorktreeRecord): Promise<void> {
  const root = path.resolve(ctx.config.workspacesDir);
  if (rec.terminalId) ctx.terminals.remove(rec.terminalId);
  for (const repo of rec.repos) {
    if (!repo.isolated || repo.workspaceId === undefined) continue;
    await unlinkRepo(rec.path, repo.name);
    const ws = resolveWorkspace(root, repo.workspaceId);
    if (ws) await removeWorktree(ws.path, repo.path);
  }
  const state = await projectWorktreeState({ ...rec, repos: [] });
  if (hasWork(state.project)) {
    await ctx.store.update((d) => {
      const r = d.projectWorktrees[wid];
      if (!r) return;
      delete r.terminalId;
      r.kept = true;
      r.repos = r.repos.filter((x) => !x.isolated);
    });
    return;
  }
  for (const repo of rec.repos) await unlinkRepo(rec.path, repo.name);
  await removeWorktree(projectDirOf(ctx.config.workspacesDir, projectId), rec.path, rec.branch);
  await ctx.store.update((d) => {
    delete d.projectWorktrees[wid];
  });
}
