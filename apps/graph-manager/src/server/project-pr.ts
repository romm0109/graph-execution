// Create PR for a project run (docs/prd/multi-repo.md, MR-09): one PR/MR per repo the apply changed, linked to each other.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AppContext } from "./app.js";
import { FORGE_NAMES, clientFor, connFor, gitAuthArgs, type ForgeKind } from "./forges.js";
import { PrError, lastLine, pushProgress, scrub, type PrJobStep, type PrStep } from "./pr.js";
import { PROJECT_NAME, readProjectFile } from "./projects.js";
import { projectRepos, type ProjectHome } from "./runhome.js";
import { readSuite, runDetail, runDirOf, taskTitle } from "./runs.js";
import { resolveWorkspace, type Workspace } from "./workspaces.js";

export interface ProjectPrRef {
  url: string;
  number: number;
  branch: string;
  base?: string;
}

export interface ProjectPrRepo {
  /** The repo's name in project.json. */
  name: string;
  workspaceId?: string;
  fullPath?: string;
  /** No PR yet, and there is something to open one from (uncommitted changes, or the `gm/<runId>` branch). */
  changed: boolean;
  pr?: ProjectPrRef;
  linked?: boolean;
  /** The error of this repo in the latest job. */
  error?: string;
}

export interface ProjectPrJobRepo {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  steps: PrJobStep[];
  error?: string;
  pr?: { url: string; number: number; branch: string };
}

/** A background Create PR of a project run: one entry per repo, then the linking of the PR bodies. */
export interface ProjectPrJob {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  repos: ProjectPrJobRepo[];
  link: { state: "pending" | "running" | "done" | "failed"; detail?: string };
  error?: string;
}

export interface ProjectPrStatus {
  project: true;
  /** The forge of the project (that of its first workspace). */
  forge?: ForgeKind;
  eligible: boolean;
  reason?: string;
  repos: ProjectPrRepo[];
  job?: ProjectPrJob;
}

const RUNS_FOLDER = ".graph-execution";
const PATHSPEC = ["--", ".", `:(exclude)${RUNS_FOLDER}`];
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
const isForge = (f: string): f is ForgeKind => f === "github" || f === "gitlab";

/** The store key of one repo's PR of a project run. `projectId` is the bare id (`billing`, not `project~billing`). */
export const prKeyOf = (projectId: string, runId: string, repo: string): string => `${projectId}/${runId}/${repo}`;
const branchOf = (runId: string): string => `gm/${runId}`;

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await execa("git", args, { cwd, env: gitEnv(), reject: false, stdin: "ignore" });
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

async function isDirty(ws: Workspace): Promise<boolean> {
  // No index refresh: the status is polled while a job may be committing in the same repo (index.lock).
  const res = await git(ws.path, ["--no-optional-locks", "status", "--porcelain", ...PATHSPEC]);
  return res.ok && res.stdout !== "";
}

async function hasBranch(ws: Workspace, branch: string): Promise<boolean> {
  return (await git(ws.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** One repo of the project with what Create PR needs to know about it. */
interface RepoInfo {
  name: string;
  workspace?: Workspace;
  startBranch?: string;
  /** The files the suite's apply changed in this repo (suite.json `repos[].applied.files`); undefined when not recorded. */
  appliedFiles?: number;
}

interface Gathered {
  projectId: string;
  /** `<project>` of the copied file names: suite.json's project name, else project.json's, else the id. */
  project: string;
  status: string;
  forge?: ForgeKind;
  repos: RepoInfo[];
}

async function gather(ctx: AppContext, home: ProjectHome, runId: string): Promise<Gathered | undefined> {
  const detail = await runDetail(home, runId);
  if (!detail) return undefined;
  const suite = await readSuite(runDirOf(home, runId));
  const file = await readProjectFile(home.path);
  const candidates = [suite?.project?.name, file?.name, home.project.id];
  const project = candidates.find((n): n is string => n !== undefined && PROJECT_NAME.test(n)) ?? home.project.id;
  const first = home.project.workspaces[0] ? resolveWorkspace(ctx.config.workspacesDir, home.project.workspaces[0]) : undefined;
  const repos = (await projectRepos(ctx.config.workspacesDir, home)).map((r) => {
    const saved = suite?.repos?.find((s) => s.name === r.name);
    const startBranch = saved?.startBranch;
    const appliedFiles = saved?.applied?.files;
    return {
      name: r.name,
      ...(r.workspace ? { workspace: r.workspace } : {}),
      ...(startBranch ? { startBranch } : {}),
      ...(appliedFiles !== undefined ? { appliedFiles } : {}),
    };
  });
  const forge = first && isForge(first.forge) ? first.forge : undefined;
  return { projectId: home.project.id, project, status: suite?.status ?? detail.summary.status, ...(forge ? { forge } : {}), repos };
}

async function repoRows(ctx: AppContext, g: Gathered, runId: string, job: ProjectPrJob | undefined): Promise<ProjectPrRepo[]> {
  const prs = ctx.store.get().prs;
  return Promise.all(
    g.repos.map(async (r) => {
      const row: ProjectPrRepo = { name: r.name, changed: false };
      if (r.workspace) {
        row.workspaceId = r.workspace.id;
        row.fullPath = r.workspace.fullPath;
      }
      const stored = prs[prKeyOf(g.projectId, runId, r.name)];
      if (stored) {
        row.pr = { url: stored.url, number: stored.number, branch: stored.branch, ...(stored.base ? { base: stored.base } : {}) };
        if (stored.linked) row.linked = true;
      } else if (r.workspace && r.appliedFiles !== 0) {
        // Only a repo the apply changed: an unrelated edit in an unchanged repo's workspace gets no PR.
        row.changed = (await isDirty(r.workspace)) || (await hasBranch(r.workspace, branchOf(runId)));
      }
      const error = job?.repos.find((j) => j.name === r.name)?.error;
      if (error !== undefined) row.error = error;
      return row;
    }),
  );
}

/** Whether the project run can get its PRs now, and each repo's PR; undefined when the run does not exist. */
export async function projectPrStatus(ctx: AppContext, home: ProjectHome, runId: string): Promise<ProjectPrStatus | undefined> {
  const g = await gather(ctx, home, runId);
  if (!g) return undefined;
  const job = currentProjectJob(ctx, home, runId);
  const repos = await repoRows(ctx, g, runId, job);
  const res: ProjectPrStatus = { project: true, ...(g.forge ? { forge: g.forge } : {}), eligible: false, repos, ...(job ? { job } : {}) };
  const reason = ((): string | undefined => {
    if (g.status !== "applied") return `the run has not landed (status ${g.status})`;
    if (!g.forge) return "the project has no supported forge";
    if (!connFor(ctx, g.forge)) return `${FORGE_NAMES[g.forge]} is not connected`;
    if (repos.some((r) => r.changed)) return undefined;
    const withPr = repos.filter((r) => r.pr);
    if (withPr.length === 0) return "no repo has changes to open a PR from";
    if (withPr.some((r) => !r.linked)) return undefined;
    return "all pull requests are open";
  })();
  if (reason === undefined) res.eligible = true;
  else res.reason = reason;
  return res;
}

/** `## Related PRs` with one line per other repo that is or will be in a PR; empty when there is none. */
export function relatedSection(self: string, others: { name: string; fullPath: string; number?: number; url?: string }[]): string {
  const lines = others
    .filter((o) => o.name !== self)
    .map((o) => (o.number !== undefined && o.url ? `- ${o.fullPath}#${o.number} ${o.url}` : `- ${o.fullPath} (opened with this one)`));
  return lines.length === 0 ? "" : ["## Related PRs", "", ...lines].join("\n");
}

/** The PR title of a repo: the first `# ` of its spec, else `<project>: graph-execution suite <runId>`. */
async function titleOf(projectDir: string, repo: string, project: string, runId: string): Promise<string> {
  const spec = await readText(path.join(projectDir, "specs", `${repo}.md`));
  return (spec !== undefined ? taskTitle(spec) : undefined) ?? `${project}: graph-execution suite ${runId}`;
}

/** The PR body of a repo without its related section: its tasks, then the generated-by line. */
async function baseBodyOf(projectDir: string, repo: string, project: string, runId: string): Promise<string> {
  const dir = path.join(projectDir, "tasks", repo);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json") && n !== "test-plan.json");
  } catch {
    // no tasks folder
  }
  const tasks: { id: string; title?: string }[] = [];
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(path.join(dir, n), "utf8")) as { id?: unknown; content?: unknown };
      const id = typeof t.id === "string" || typeof t.id === "number" ? String(t.id) : n.slice(0, -".json".length);
      const title = typeof t.content === "string" ? taskTitle(t.content) : undefined;
      tasks.push({ id, ...(title ? { title } : {}) });
    } catch {
      // not a task file
    }
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const lines = tasks.map((t) => (t.title ? `- [x] ${t.id} ${t.title}` : `- [x] ${t.id}`));
  return [...lines, ...(lines.length ? [""] : []), `Generated by graph-execution suite ${runId} (project ${project}).`].join("\n");
}

const withRelated = (base: string, related: string): string => (related === "" ? base : `${base}\n\n${related}`);

interface ProjectRegistry {
  jobs: Map<string, ProjectPrJob>;
  starting: Set<string>;
}

const registries = new WeakMap<AppContext, ProjectRegistry>();
function registryOf(ctx: AppContext): ProjectRegistry {
  let r = registries.get(ctx);
  if (!r) {
    r = { jobs: new Map(), starting: new Set() };
    registries.set(ctx, r);
  }
  return r;
}

const jobKey = (home: ProjectHome, runId: string): string => `${home.project.id}/${runId}`;

/** The latest Create PR job of the project run, if this server started one. */
export function currentProjectJob(ctx: AppContext, home: ProjectHome, runId: string): ProjectPrJob | undefined {
  return registryOf(ctx).jobs.get(jobKey(home, runId));
}

interface Plan {
  g: Gathered;
  forge: ForgeKind;
  token: string;
  projectDir: string;
  /** Repos that get or have a PR in this run: changed ones and those with a stored PR. */
  participants: Set<string>;
  changed: Set<string>;
}

/** Checks that the run can get its PRs (throws `PrError`), then starts the job in the background and returns it. */
export async function startProjectPr(ctx: AppContext, home: ProjectHome, runId: string): Promise<ProjectPrJob> {
  const { jobs, starting } = registryOf(ctx);
  const key = jobKey(home, runId);
  if (jobs.get(key)?.status === "running" || starting.has(key)) throw new PrError(409, "pull requests are already being created");
  starting.add(key);
  let plan: Plan;
  try {
    const status = await projectPrStatus(ctx, home, runId);
    if (!status) throw new PrError(404, "unknown run");
    if (!status.eligible) throw new PrError(409, status.reason ?? "all pull requests are open");
    const g = (await gather(ctx, home, runId))!;
    const conn = g.forge ? connFor(ctx, g.forge) : undefined;
    if (!g.forge || !conn) throw new PrError(409, g.forge ? `${FORGE_NAMES[g.forge]} is not connected` : "the project has no supported forge");
    const changed = new Set(status.repos.filter((r) => r.changed).map((r) => r.name));
    const participants = new Set(status.repos.filter((r) => r.changed || r.pr).map((r) => r.name));
    plan = { g, forge: g.forge, token: conn.token, projectDir: home.path, participants, changed };
  } finally {
    starting.delete(key);
  }
  const job: ProjectPrJob = {
    id: randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    repos: plan.g.repos.map((r) => ({
      name: r.name,
      status: "pending",
      steps: (["checkout", "commit", "push", "create"] as const).map((name) => ({ name, state: "pending" })),
    })),
    link: { state: "pending" },
  };
  jobs.set(key, job);
  void runProjectPrJob(job, ctx, runId, plan);
  return job;
}

class StepFailed extends Error {}

/** Opens the PR of one changed repo, updating `jr` in place. Never throws. */
async function openRepoPr(
  ctx: AppContext,
  runId: string,
  plan: Plan,
  repo: RepoInfo & { workspace: Workspace },
  jr: ProjectPrJobRepo,
  related: string,
): Promise<void> {
  const { forge, token, projectDir, g } = plan;
  const ws = repo.workspace;
  const branch = branchOf(runId);
  const stepOf = (name: PrStep): PrJobStep => jr.steps.find((s) => s.name === name)!;
  const set = (name: PrStep, patch: Partial<PrJobStep>): void => {
    const s = stepOf(name);
    Object.assign(s, patch);
    if (s.detail !== undefined) s.detail = scrub(s.detail, token);
  };
  let current: PrStep = "checkout";
  const begin = (name: PrStep, detail?: string): void => {
    current = name;
    set(name, { state: "running", ...(detail !== undefined ? { detail } : {}) });
  };
  const fail = (message: string): never => {
    throw new StepFailed(message);
  };
  const run = async (args: string[], onStderr?: (chunk: string) => void): Promise<string> => {
    const sub = execa("git", args, { cwd: ws.path, env: gitEnv(), reject: false, stdin: "ignore" });
    if (onStderr) sub.stderr?.on("data", (c: Buffer | string) => onStderr(String(c)));
    const res = await sub;
    if (res.exitCode !== 0) fail(lastLine(String(res.stderr ?? "") || String(res.stdout ?? "") || (res.message ?? "")));
    return String(res.stdout ?? "").trim();
  };

  jr.status = "running";
  const head = await git(ws.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const original = head.ok && head.stdout !== "" ? head.stdout : undefined;
  try {
    const dirty = await isDirty(ws);
    const exists = await hasBranch(ws, branch);
    const title = await titleOf(projectDir, repo.name, g.project, runId);
    if (exists && dirty) {
      begin("checkout", branch);
      fail(`branch ${branch} already exists`);
    }
    if (exists) {
      set("checkout", { state: "done", detail: "already committed" });
      set("commit", { state: "done", detail: "already committed" });
    } else {
      begin("checkout", branch);
      // `--branch` also expands `@{-1}`; only a name that comes back unchanged is a plain, valid branch name.
      const valid = await git(ws.path, ["check-ref-format", "--branch", branch]);
      if (!valid.ok || valid.stdout !== branch) fail(`invalid branch name: ${branch}`);
      await run(["checkout", "-b", branch]);
      set("checkout", { state: "done" });
      let committed = false;
      try {
        begin("commit");
        // The spec and the contract land in the same commit: they must exist before `git add`.
        const doneDir = path.join(ws.path, "docs", "prd", "done");
        await mkdir(doneDir, { recursive: true });
        const copied: string[] = [];
        const spec = path.join(projectDir, "specs", `${repo.name}.md`);
        if ((await readText(spec)) !== undefined) {
          await copyFile(spec, path.join(doneDir, `${g.project}.md`));
          copied.push(`docs/prd/done/${g.project}.md`);
        }
        const contract = path.join(projectDir, "contract.md");
        if ((await readText(contract)) !== undefined) {
          await copyFile(contract, path.join(doneDir, `${g.project}-contract.md`));
          copied.push(`docs/prd/done/${g.project}-contract.md`);
        }
        await run(["add", "-A", "--", "."]);
        await run(["reset", "-q", "--", RUNS_FOLDER]);
        const staged = await run(["diff", "--cached", "--name-only"]);
        const files = staged === "" ? 0 : staged.split("\n").length;
        set("commit", { detail: `${files} ${files === 1 ? "file" : "files"} · “${title}”${copied.length ? ` · ${copied.join(", ")}` : ""}` });
        const email = await git(ws.path, ["config", "user.email"]);
        const identity = email.stdout === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
        await run([...identity, "commit", "-m", title, "-m", withRelated(await baseBodyOf(projectDir, repo.name, g.project, runId), "")]);
        committed = true;
        set("commit", { state: "done" });
      } finally {
        if (original) await git(ws.path, ["checkout", "--quiet", original]);
        // Nothing was committed: drop the branch again (it is where `original` is), so a retry starts afresh.
        if (!committed && original) await git(ws.path, ["branch", "-D", branch]);
      }
    }

    begin("push", "origin");
    await run([...gitAuthArgs(forge, token), "push", "--progress", "-u", "origin", branch], (chunk) => {
      const p = pushProgress(chunk);
      if (p !== undefined) set("push", { progress: p, detail: `origin · ${Math.round(p * 100)}%` });
    });
    set("push", { state: "done", detail: "origin", progress: 1 });

    let base = repo.startBranch ?? original;
    if (!base) {
      try {
        base = (await clientFor(ctx, forge).getRepo(ws.fullPath)).defaultBranch;
      } catch {
        // fall through to main
      }
    }
    const target = base || "main";
    begin("create", `${FORGE_NAMES[forge]} ${forge === "gitlab" ? "MR" : "PR"} → ${target}`);
    const body = withRelated(await baseBodyOf(projectDir, repo.name, g.project, runId), related);
    const pr = await clientFor(ctx, forge)
      .createPullRequest({ fullPath: ws.fullPath, head: branch, base: target, title, body })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    await ctx.store.update((d) => {
      d.prs[prKeyOf(g.projectId, runId, repo.name)] = { url: pr.url, number: pr.number, branch, base: target, forge, createdAt: new Date().toISOString() };
    });
    set("create", { state: "done" });
    jr.pr = { url: pr.url, number: pr.number, branch };
    jr.status = "done";
  } catch (err) {
    const message = err instanceof StepFailed ? err.message : ((err as Error)?.message ?? String(err));
    set(current, { state: "failed" });
    jr.error = scrub(`${current} failed: ${message}`, token);
    jr.status = "failed";
  }
}

/** The other participants of the run as `relatedSection` takes them, with the numbers known now. */
function othersOf(ctx: AppContext, runId: string, plan: Plan): { name: string; fullPath: string; number?: number; url?: string }[] {
  const prs = ctx.store.get().prs;
  return plan.g.repos
    .filter((r) => plan.participants.has(r.name))
    .map((r) => {
      const stored = prs[prKeyOf(plan.g.projectId, runId, r.name)];
      return { name: r.name, fullPath: r.workspace?.fullPath ?? r.name, ...(stored ? { number: stored.number, url: stored.url } : {}) };
    });
}

/** Opens the missing PRs repo by repo, then links every PR body to the others. Never throws. */
async function runProjectPrJob(job: ProjectPrJob, ctx: AppContext, runId: string, plan: Plan): Promise<void> {
  const { g, token } = plan;
  try {
    for (const repo of g.repos) {
      const jr = job.repos.find((r) => r.name === repo.name)!;
      const stored = ctx.store.get().prs[prKeyOf(g.projectId, runId, repo.name)];
      if (stored) {
        jr.pr = { url: stored.url, number: stored.number, branch: stored.branch };
        for (const s of jr.steps) Object.assign(s, { state: "done", detail: "already open" });
        jr.status = "skipped";
        continue;
      }
      if (!plan.changed.has(repo.name)) {
        jr.status = "skipped";
        continue;
      }
      if (!repo.workspace) {
        jr.status = "failed";
        jr.error = "the repo's workspace is missing";
        continue;
      }
      await openRepoPr(ctx, runId, plan, { ...repo, workspace: repo.workspace }, jr, relatedSection(repo.name, othersOf(ctx, runId, plan)));
    }

    const prs = ctx.store.get().prs;
    const members = g.repos.filter((r) => plan.participants.has(r.name));
    const allOpen = members.length > 0 && members.every((r) => prs[prKeyOf(g.projectId, runId, r.name)] !== undefined);
    if (allOpen) {
      job.link = { state: "running" };
      const others = othersOf(ctx, runId, plan);
      const failures: string[] = [];
      for (const r of members) {
        const key = prKeyOf(g.projectId, runId, r.name);
        const stored = ctx.store.get().prs[key]!;
        if (members.length > 1) {
          try {
            const body = withRelated(await baseBodyOf(plan.projectDir, r.name, g.project, runId), relatedSection(r.name, others));
            await clientFor(ctx, stored.forge).updatePullRequest({ fullPath: r.workspace?.fullPath ?? r.name, number: stored.number, body });
          } catch (err) {
            failures.push(`${r.name}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        await ctx.store.update((d) => {
          const rec = d.prs[key];
          if (rec) rec.linked = true;
        });
      }
      job.link = failures.length === 0 ? { state: "done" } : { state: "failed", detail: scrub(failures.join("; "), token) };
    } else {
      job.link = { state: "pending", detail: "waiting for every pull request" };
    }

    const failed = job.repos.filter((r) => r.status === "failed");
    const errors = failed.map((r) => `${r.name}: ${r.error ?? "failed"}`);
    if (job.link.state === "failed") errors.push(`linking failed: ${job.link.detail ?? "unknown error"}`);
    if (failed.length === 0 && job.link.state === "done") job.status = "done";
    else {
      job.error = scrub(errors.join("; ") || "not every pull request could be opened", token);
      job.status = "failed";
    }
  } catch (err) {
    job.error = scrub(err instanceof Error ? err.message : String(err), token);
    job.status = "failed";
  }
}
