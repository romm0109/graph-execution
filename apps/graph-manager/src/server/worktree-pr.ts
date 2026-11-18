// Create PR from a terminal's worktree (docs/prd/done/isolated-workspaces.md, KAN-100): commit what the terminal left in its
// own worktree, push its `gm-term/<id>` branch and open a PR. Same steps and Retry as a run's Create PR; nothing touches
// the workspace checkout. Once the PR exists the worktree goes (its terminal closes) and the branch stays.
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import type { AppContext } from "./app.js";
import { FORGE_NAMES, clientFor, connFor, gitAuthArgs, type ForgeKind } from "./forges.js";
import { PrError, accessMessage, isAccessDenied, lastLine, missingBase, pushProgress, scrub, type PrJob, type PrJobStep, type PrStep } from "./pr.js";
import type { TerminalWorktreeRecord } from "./store.js";
import type { Workspace } from "./workspaces.js";
import { removeWorktree, worktreeState } from "./worktrees.js";

export interface WorktreePrInput {
  title?: string;
  body?: string;
  base?: string;
  retry?: boolean;
}

/** The store key of a terminal worktree's PR. */
export const worktreePrKey = (ws: Workspace, wid: string): string => `${ws.id}/term-${wid}`;

const jobsOf = new WeakMap<AppContext, Map<string, PrJob>>();
function jobs(ctx: AppContext): Map<string, PrJob> {
  let m = jobsOf.get(ctx);
  if (!m) {
    m = new Map();
    jobsOf.set(ctx, m);
  }
  return m;
}

export function currentWorktreeJob(ctx: AppContext, ws: Workspace, wid: string): PrJob | undefined {
  return jobs(ctx).get(worktreePrKey(ws, wid));
}

const isForge = (f: string): f is ForgeKind => f === "github" || f === "gitlab";
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/** Checks, then starts the job in the background. Throws `PrError`. */
export async function startWorktreePr(ctx: AppContext, ws: Workspace, wid: string, rec: TerminalWorktreeRecord, given: WorktreePrInput): Promise<PrJob> {
  const key = worktreePrKey(ws, wid);
  const last = jobs(ctx).get(key);
  if (last?.status === "running") throw new PrError(409, "a pull request is already being created");
  if (given.retry && last?.status !== "failed") throw new PrError(409, "no failed Create PR to retry");
  if (!isForge(ws.forge)) throw new PrError(409, `${ws.forge} is not a supported forge`);
  const forge = ws.forge;
  const conn = connFor(ctx, forge);
  if (!conn) throw new PrError(409, `${FORGE_NAMES[forge]} is not connected`);
  const state = await worktreeState(rec.path, rec.base);
  if (state.dirty === 0 && state.ahead === 0) throw new PrError(409, "the worktree has no changes");
  const title = (given.title?.trim() || (given.retry ? last?.title : undefined) || rec.title).trim();
  const body = given.body ?? (given.retry ? last?.body : undefined) ?? "";
  let base = given.base?.trim() || (given.retry ? last?.base : undefined) || rec.baseBranch;
  if (!base) {
    try {
      base = (await clientFor(ctx, forge).getRepo(ws.fullPath)).defaultBranch;
    } catch {
      base = "main";
    }
  }
  const job: PrJob = {
    id: randomUUID(),
    status: "running",
    steps: (["access", "commit", "push", "create"] as const).map((name) => ({ name, state: "pending" })),
    base,
    branch: rec.branch,
    startedAt: new Date().toISOString(),
    title,
    body,
  };
  jobs(ctx).set(key, job);
  void runWorktreePrJob(job, ctx, ws, wid, rec, { forge, token: conn.token, title, body, base });
  return job;
}

class StepFailed extends Error {}

async function runWorktreePrJob(
  job: PrJob,
  ctx: AppContext,
  ws: Workspace,
  wid: string,
  rec: TerminalWorktreeRecord,
  p: { forge: ForgeKind; token: string; title: string; body: string; base: string },
): Promise<void> {
  const { forge, token, title, body, base } = p;
  const branch = rec.branch;
  const set = (name: PrStep, patch: Partial<PrJobStep>): void => {
    const s = job.steps.find((x) => x.name === name)!;
    Object.assign(s, patch);
    if (s.detail !== undefined) s.detail = scrub(s.detail, token);
  };
  let current: PrStep = "access";
  const begin = (name: PrStep, detail?: string): void => {
    current = name;
    set(name, { state: "running", ...(detail !== undefined ? { detail } : {}) });
  };
  const run = async (args: string[], cwd: string, onStderr?: (chunk: string) => void): Promise<string> => {
    const sub = execa("git", args, { cwd, env: gitEnv(), reject: false, stdin: "ignore" });
    if (onStderr) sub.stderr?.on("data", (c: Buffer | string) => onStderr(String(c)));
    const res = await sub;
    if (res.exitCode !== 0) {
      const text = String(res.stderr ?? "") || String(res.stdout ?? "") || (res.message ?? "");
      throw new StepFailed(isAccessDenied(text) && args.includes("push") ? `${accessMessage(forge, ws.fullPath)} (${lastLine(text)})` : lastLine(text));
    }
    return String(res.stdout ?? "").trim();
  };
  const auth = gitAuthArgs(forge, token);
  try {
    begin("access", `origin · ${ws.fullPath}`);
    await run([...auth, "push", "--dry-run", "--porcelain", "origin", `${branch}:refs/heads/${branch}`], rec.path);
    const noBase = await missingBase(rec.path, auth, base);
    if (noBase) throw new StepFailed(noBase);
    set("access", { state: "done" });

    begin("commit");
    const status = await run(["status", "--porcelain"], rec.path);
    if (status === "") set("commit", { state: "done", detail: "already committed" });
    else {
      await run(["add", "-A", "--", "."], rec.path);
      const staged = await run(["diff", "--cached", "--name-only"], rec.path);
      const files = staged === "" ? 0 : staged.split("\n").length;
      const email = await execa("git", ["config", "user.email"], { cwd: rec.path, reject: false });
      const identity = String(email.stdout ?? "").trim() === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
      await run([...identity, "commit", "-q", "-m", title, "-m", body], rec.path);
      set("commit", { state: "done", detail: `${files} ${files === 1 ? "file" : "files"} · “${title}”` });
    }

    begin("push", "origin");
    await run([...auth, "push", "--progress", "origin", `${branch}:refs/heads/${branch}`], rec.path, (chunk) => {
      const pr = pushProgress(chunk);
      if (pr !== undefined) set("push", { progress: pr, detail: `origin · ${Math.round(pr * 100)}%` });
    });
    set("push", { state: "done", detail: "origin", progress: 1 });

    begin("create", `${FORGE_NAMES[forge]} ${forge === "gitlab" ? "MR" : "PR"} → ${base}`);
    const client = clientFor(ctx, forge);
    const pr = await client.createPullRequest({ fullPath: ws.fullPath, head: branch, base, title, body }).catch(async (err: unknown) => {
      const found = await client.findPullRequest?.({ fullPath: ws.fullPath, head: branch }).catch(() => undefined);
      if (found) return found;
      throw new StepFailed(err instanceof Error ? err.message : String(err));
    });
    set("create", { state: "done" });
    // The work is on the forge: the terminal and its worktree go, the branch stays for the PR.
    if (rec.terminalId) ctx.terminals.remove(rec.terminalId);
    await removeWorktree(ws.path, rec.path);
    await ctx.store.update((d) => {
      d.prs[worktreePrKey(ws, wid)] = { url: pr.url, number: pr.number, branch, base, forge, createdAt: new Date().toISOString() };
      delete d.terminalWorktrees[wid];
    });
    job.pr = { url: pr.url, number: pr.number, branch };
    job.status = "done";
  } catch (err) {
    const message = err instanceof StepFailed ? err.message : (err as Error)?.message ?? String(err);
    set(current, { state: "failed" });
    job.failedStep = current;
    job.error = scrub(`${current} failed: ${message}`, token);
    job.status = "failed";
  }
}
