import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AppContext } from "./app.js";
import { FORGE_NAMES, clientFor, connFor, gitAuthArgs, type ForgeKind } from "./forges.js";
import { runDetail, taskTitle, type RunDetail } from "./runs.js";
import { moveSpecToDone } from "./specdone.js";
import type { Workspace } from "./workspaces.js";
import { tempWorktree, WORKTREES_DIR } from "./worktrees.js";

export interface PrRef {
  url: string;
  number: number;
  branch: string;
  /** The branch the PR targets; missing on PRs stored before it was recorded. */
  base?: string;
}

export interface PrSuggestion {
  branch: string;
  title: string;
  body: string;
  base: string;
  /** The remote's branches (origin/… without the prefix), the suggested base first. */
  bases: string[];
}

export interface PrStatus {
  pr?: PrRef;
  eligible: boolean;
  reason?: string;
  suggested?: PrSuggestion;
}

/** `GET …/pr`: the status plus the latest Create PR job of the run, if any. */
export interface PrStatusWithJob extends PrStatus {
  job?: PrJob;
}

export interface PrInput {
  /** Ignored for a run: its PR always comes from `graph/<run-id>`. */
  branch?: string;
  title: string;
  body: string;
  base?: string;
}

/** `access`, `commit`, `push`, `create` for a run; a project's repos keep `checkout`, `commit`, `push`, `create`. */
export type PrStep = "access" | "checkout" | "commit" | "push" | "create";

export interface PrJobStep {
  name: PrStep;
  state: "pending" | "running" | "done" | "failed";
  detail?: string;
  /** 0..1 while the push writes objects. */
  progress?: number;
}

/** A background Create PR: its steps as they run, then the PR or the error. Kept in memory until the run's next job. */
export interface PrJob {
  id: string;
  status: "running" | "done" | "failed";
  steps: PrJobStep[];
  error?: string;
  failedStep?: PrStep;
  pr?: { url: string; number: number; branch: string };
  base: string;
  branch: string;
  startedAt: string;
  /** What was asked, for a Retry that sends nothing else. */
  title?: string;
  body?: string;
}

/** A Create PR that can't start: `status` is the HTTP status to answer. The message never holds the token. */
export class PrError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PrError";
  }
}

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

const prKey = (ws: Workspace, runId: string): string => `${ws.id}/${runId}`;
const isForge = (f: string): f is ForgeKind => f === "github" || f === "gitlab";

async function git(ws: Workspace, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await execa("git", args, { cwd: ws.path, env: gitEnv(), reject: false, stdin: "ignore" });
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

export function scrub(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("***");
}

/** The last `error:`/`fatal:` line of git's output, else its last non-hint line. */
export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("hint:"));
  return lines.filter((l) => /^(error|fatal):/.test(l)).pop() ?? lines.pop() ?? "unknown error";
}

/**
 * Fails Create PR before the forge does when `base` is not a branch of origin: GitHub answers that with a bare
 * "422 Validation Failed". A base that only exists locally (the branch a worktree or run started from) is the usual case.
 * `ls-remote` itself failing proves nothing, so then the forge decides.
 */
export async function missingBase(cwd: string, auth: string[], base: string): Promise<string | undefined> {
  const res = await execa("git", [...auth, "ls-remote", "--heads", "origin", `refs/heads/${base}`], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    reject: false,
    stdin: "ignore",
  });
  if (res.exitCode !== 0 || String(res.stdout ?? "").trim() !== "") return undefined;
  return `base branch ${base} is not on origin: push it first, or Retry with another base`;
}

/** The first `# ` heading of the spec file, if it can be read. */
async function specTitle(ws: Workspace, specPath: string): Promise<string | undefined> {
  try {
    return taskTitle(await readFile(path.resolve(ws.path, specPath), "utf8"));
  } catch {
    return undefined;
  }
}

async function suggest(ctx: AppContext, ws: Workspace, runId: string, detail: RunDetail): Promise<PrSuggestion> {
  const state = detail.state;
  const title = (state && (await specTitle(ws, state.specPath))) ?? `graph-execution run ${runId}`;
  const tasks = (detail.graph?.nodes ?? []).map((n) => `- [x] ${n.id} ${n.title}`);
  const body = [...tasks, ...(tasks.length ? [""] : []), `Generated by graph-execution run ${runId}.`].join("\n");
  // Merge into: the branch the run started from (Start from), else the one it applied to, else the checkout's.
  // A run started from `origin/x` proposes `x`; a terminal's own `gm-term/…` branch is not a PR target.
  const started = ctx.store.get().runBases[prKey(ws, runId)]?.base?.replace(/^origin\//, "");
  let base = started && !started.startsWith("gm-term/") ? started : state?.targetBranch;
  if (!base) {
    const cur = await git(ws, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (cur.ok && cur.stdout !== "" && cur.stdout !== "HEAD") base = cur.stdout;
  }
  if (!base && isForge(ws.forge)) {
    try {
      base = (await clientFor(ctx, ws.forge).getRepo(ws.fullPath)).defaultBranch;
    } catch {
      // fall through to main
    }
  }
  const suggestedBase = base ?? "main";
  return { branch: runBranchOf(runId), title, body, base: suggestedBase, bases: await remoteBranches(ws, suggestedBase) };
}

/** The branches of `origin` without the `origin/` prefix and without `HEAD`, `first` leading (and always present). */
async function remoteBranches(ws: Workspace, first: string): Promise<string[]> {
  const refs = await git(ws, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
  const prefix = "refs/remotes/origin/";
  const names = refs.ok
    ? refs.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length))
        .filter((n) => n !== "" && n !== "HEAD")
    : [];
  return [first, ...names.filter((n) => n !== first).sort((a, b) => a.localeCompare(b))];
}

/** The run's branch: the engine leaves the result there (docs/prd/done/isolated-workspaces.md). */
export const runBranchOf = (runId: string): string => `graph/${runId}`;

/** A ref for `base` in the workspace's repo: the local branch, else `origin/<base>`; undefined when neither exists. */
async function baseRef(ws: Workspace, base: string): Promise<string | undefined> {
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    if ((await git(ws, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok) return ref;
  }
  return undefined;
}

/** Commits on `branch` that `base` does not have; undefined when the base is unknown here. */
async function aheadOf(ws: Workspace, branch: string, base: string): Promise<number | undefined> {
  const ref = await baseRef(ws, base);
  if (!ref) return undefined;
  const res = await git(ws, ["rev-list", "--count", `${ref}..${branch}`]);
  return res.ok ? Number(res.stdout) || 0 : undefined;
}

/** Whether the run can get a PR now, or the PR it already has; undefined when the run does not exist. */
export async function prStatus(ctx: AppContext, ws: Workspace, runId: string): Promise<PrStatus | undefined> {
  const detail = await runDetail(ws, runId);
  if (!detail) return undefined;
  const stored = ctx.store.get().prs[prKey(ws, runId)];
  if (stored) {
    const pr: PrRef = { url: stored.url, number: stored.number, branch: stored.branch };
    if (stored.base) pr.base = stored.base;
    return { pr, eligible: false };
  }
  const status = detail.state?.status ?? detail.summary.status;
  if (!detail.state || (status !== "done" && status !== "applied")) return { eligible: false, reason: `the run has not landed (status ${status})` };
  const branch = runBranchOf(runId);
  if (!(await git(ws, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok) return { eligible: false, reason: `the run's branch ${branch} is gone` };
  if (!isForge(ws.forge)) return { eligible: false, reason: `${ws.forge} is not a supported forge` };
  if (!connFor(ctx, ws.forge)) return { eligible: false, reason: `${FORGE_NAMES[ws.forge]} is not connected` };
  const suggested = await suggest(ctx, ws, runId, detail);
  // Against the run's own start commit: a run that changed nothing has nothing to propose.
  const made = await git(ws, ["rev-list", "--count", `${detail.state.startingCommit}..${branch}`]);
  if (made.ok && Number(made.stdout) === 0) return { eligible: false, reason: "the run made no changes" };
  return { eligible: true, suggested };
}

/** A Create PR that passed the checks: what the job needs to run. */
export interface PreparedPr {
  forge: ForgeKind;
  token: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** The run's spec (absolute), moved to a `done/` folder next to it in a commit on the run's branch. */
  specPath?: string;
}

/** The synchronous checks of Create PR, before any git command that changes something. Throws `PrError`. */
export async function preparePr(ctx: AppContext, ws: Workspace, runId: string, input: PrInput): Promise<PreparedPr> {
  const status = await prStatus(ctx, ws, runId);
  if (!status) throw new PrError(404, "unknown run");
  if (!status.eligible || !status.suggested || !isForge(ws.forge)) throw new PrError(409, status.reason ?? "a pull request already exists for this run");
  const forge = ws.forge;
  const conn = connFor(ctx, forge);
  if (!conn) throw new PrError(409, `${FORGE_NAMES[forge]} is not connected`);
  // The PR always comes from the run's own branch; an older client may still send `gm/<run-id>`.
  const branch = runBranchOf(runId);
  const base = input.base?.trim() || status.suggested.base;
  if (base.startsWith("-") || base === branch) throw new PrError(400, `invalid base branch: ${base}`);
  const ahead = await aheadOf(ws, branch, base);
  if (ahead === 0) throw new PrError(409, `${branch} has no commits that ${base} does not have`);
  const specPath = (await runDetail(ws, runId))?.state?.specPath;
  return { forge, token: conn.token, branch, base, title: input.title, body: input.body, ...(specPath ? { specPath } : {}) };
}

/** `Writing objects:  62% (5/8)` in git's push progress → 0.62; the last match of the chunk wins. */
export function pushProgress(chunk: string): number | undefined {
  let found: number | undefined;
  for (const part of chunk.split(/[\r\n]/)) {
    const m = /Writing objects:\s+(\d+)%/.exec(part);
    if (m) found = Math.min(100, Number(m[1])) / 100;
  }
  return found;
}

/** A push rejected for the token's rights (HTTP 401/403, "permission denied"…), not for the branch itself. */
export function isAccessDenied(text: string): boolean {
  return /\b(401|403)\b|permission|denied|not allowed|authentication failed|could not read username/i.test(text);
}

/** The message of a push the forge refused for the token's rights. */
export function accessMessage(forge: ForgeKind, fullPath: string): string {
  const scope = forge === "github" ? 'GitHub: "Contents: Read and write"' : "GitLab: the write_repository scope and Developer role";
  return `the ${FORGE_NAMES[forge]} token can't push to ${fullPath}: give it write access to the repository's contents (${scope}), then Retry`;
}

/** The spec's path relative to the folder it lived in (the workspace, or a terminal's worktree), with `/`. */
function specRel(ws: Workspace, specPath: string): { root: string; rel: string } | undefined {
  const wt = path.join(ws.path, WORKTREES_DIR);
  let root = ws.path;
  const inWt = path.relative(wt, specPath);
  if (!inWt.startsWith("..") && !path.isAbsolute(inWt) && inWt.split(path.sep).length > 1) root = path.join(wt, inWt.split(path.sep)[0]!);
  const rel = path.relative(root, specPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return { root, rel: rel.split(path.sep).join("/") };
}

class StepFailed extends Error {}

/**
 * Runs the steps of a prepared Create PR, updating `job` in place. Never throws: a failure ends in `status: "failed"`.
 * Nothing here touches the workspace checkout: the spec move is committed in a throwaway worktree, and the run's branch
 * is pushed as it is. Every step can run again, so a Retry is a new job over the same branch.
 */
export async function runPrJob(job: PrJob, ctx: AppContext, ws: Workspace, runId: string, prep: PreparedPr): Promise<void> {
  const { forge, token, branch, base, title, body } = prep;
  const stepOf = (name: PrStep): PrJobStep => job.steps.find((s) => s.name === name)!;
  const set = (name: PrStep, patch: Partial<PrJobStep>): void => {
    const s = stepOf(name);
    Object.assign(s, patch);
    if (s.detail !== undefined) s.detail = scrub(s.detail, token);
  };
  let current: PrStep = "access";
  const begin = (name: PrStep, detail?: string): void => {
    current = name;
    set(name, { state: "running", ...(detail !== undefined ? { detail } : {}) });
  };
  const fail = (message: string): never => {
    throw new StepFailed(message);
  };
  const run = async (args: string[], cwd = ws.path, onStderr?: (chunk: string) => void): Promise<string> => {
    const sub = execa("git", args, { cwd, env: gitEnv(), reject: false, stdin: "ignore", all: false });
    if (onStderr) sub.stderr?.on("data", (c: Buffer | string) => onStderr(String(c)));
    const res = await sub;
    if (res.exitCode !== 0) {
      const text = String(res.stderr ?? "") || String(res.stdout ?? "") || (res.message ?? "");
      fail(isAccessDenied(text) && args.includes("push") ? `${accessMessage(forge, ws.fullPath)} (${lastLine(text)})` : lastLine(text));
    }
    return String(res.stdout ?? "").trim();
  };
  const auth = gitAuthArgs(forge, token);

  try {
    // Push access first (the GitHub push bug): a read-only token fails here, before anything is made.
    begin("access", `origin · ${ws.fullPath}`);
    await run([...auth, "push", "--dry-run", "--porcelain", "origin", `${branch}:refs/heads/${branch}`]);
    const noBase = await missingBase(ws.path, auth, base);
    if (noBase) fail(noBase);
    set("access", { state: "done" });

    begin("commit");
    const spec = prep.specPath ? specRel(ws, prep.specPath) : undefined;
    const done = spec ? `${path.posix.dirname(spec.rel)}/done/${path.posix.basename(spec.rel)}` : undefined;
    const onBranch = async (rel: string) => (await git(ws, ["cat-file", "-e", `${branch}:${rel}`])).ok;
    if (!spec || !done || path.posix.basename(path.posix.dirname(spec.rel)) === "done" || spec.rel.startsWith(".graph-execution/")) {
      set("commit", { state: "done", detail: "nothing to commit" });
    } else if (await onBranch(done)) {
      set("commit", { state: "done", detail: `spec already in ${done}` });
    } else {
      // The spec moves to done/ in one commit on the run's branch, made in a throwaway worktree.
      const old = await run(["rev-parse", `refs/heads/${branch}`]);
      const tmp = await tempWorktree(ws.path, old, `pr-${runId}`).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      try {
        let moved: string | undefined;
        if (await onBranch(spec.rel)) moved = await moveSpecToDone(tmp.path, spec.rel);
        else {
          // The spec was never committed: it goes straight into done/ from where the run read it.
          const text = await readFile(path.join(spec.root, ...spec.rel.split("/")), "utf8").catch(() => undefined);
          if (text !== undefined) {
            await mkdir(path.join(tmp.path, ...path.posix.dirname(done).split("/")), { recursive: true });
            await writeFile(path.join(tmp.path, ...done.split("/")), text);
            await run(["add", "--", done], tmp.path);
            moved = done;
          }
        }
        if (moved) {
          const email = await git({ ...ws, path: tmp.path }, ["config", "user.email"]);
          const identity = email.stdout === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
          await run([...identity, "commit", "-q", "-m", `Move the spec to ${moved}`], tmp.path);
          const head = await run(["rev-parse", "HEAD"], tmp.path);
          await run(["update-ref", `refs/heads/${branch}`, head, old]);
          set("commit", { state: "done", detail: `spec → ${moved}` });
        } else set("commit", { state: "done", detail: "nothing to commit" });
      } finally {
        await tmp.dispose();
      }
    }

    begin("push", "origin");
    await run([...auth, "push", "--progress", "origin", `${branch}:refs/heads/${branch}`], ws.path, (chunk) => {
      const p = pushProgress(chunk);
      if (p !== undefined) set("push", { progress: p, detail: `origin · ${Math.round(p * 100)}%` });
    });
    set("push", { state: "done", detail: "origin", progress: 1 });

    begin("create", `${FORGE_NAMES[forge]} ${forge === "gitlab" ? "MR" : "PR"} → ${base}`);
    const client = clientFor(ctx, forge);
    const pr = await client.createPullRequest({ fullPath: ws.fullPath, head: branch, base, title, body }).catch(async (err: unknown) => {
      // A Retry after the PR was made (the answer was lost): use the open one.
      const found = await client.findPullRequest?.({ fullPath: ws.fullPath, head: branch }).catch(() => undefined);
      return found ?? fail(err instanceof Error ? err.message : String(err));
    });
    await ctx.store.update((d) => {
      d.prs[prKey(ws, runId)] = { url: pr.url, number: pr.number, branch, base, forge, createdAt: new Date().toISOString() };
    });
    set("create", { state: "done" });
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

interface PrRegistry {
  jobs: Map<string, PrJob>;
  /** Runs whose POST is past the "already running" check but still in `preparePr`. */
  starting: Set<string>;
}

/** One job registry per app instance (keyed by its context), so apps in one process never share jobs. */
const registries = new WeakMap<AppContext, PrRegistry>();
function registryOf(ctx: AppContext): PrRegistry {
  let r = registries.get(ctx);
  if (!r) {
    r = { jobs: new Map(), starting: new Set() };
    registries.set(ctx, r);
  }
  return r;
}

/** The latest Create PR job of the run, if this server started one. */
export function currentJob(ctx: AppContext, ws: Workspace, runId: string): PrJob | undefined {
  return registryOf(ctx).jobs.get(prKey(ws, runId));
}

/**
 * Checks the input (throws `PrError`), then starts the job in the background and returns it. `retry`: start again after
 * a failed job, with its title, body and base unless given (every step can run again).
 */
export async function startPr(ctx: AppContext, ws: Workspace, runId: string, given: Partial<PrInput> & { retry?: boolean }): Promise<PrJob> {
  const { jobs, starting } = registryOf(ctx);
  const key = prKey(ws, runId);
  if (jobs.get(key)?.status === "running" || starting.has(key)) throw new PrError(409, "a pull request is already being created");
  const last = jobs.get(key);
  if (given.retry && last?.status !== "failed") throw new PrError(409, "no failed Create PR to retry");
  const pick = (v: string | undefined, old: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v : old);
  const title = pick(given.title, given.retry ? last?.title : undefined);
  if (title === undefined) throw new PrError(400, "title is required");
  const input: PrInput = {
    title,
    body: given.body ?? (given.retry ? last?.body : undefined) ?? "",
    ...(pick(given.base, given.retry ? last?.base : undefined) ? { base: pick(given.base, given.retry ? last?.base : undefined)! } : {}),
  };
  starting.add(key);
  let prep: PreparedPr;
  try {
    prep = await preparePr(ctx, ws, runId, input);
  } finally {
    starting.delete(key);
  }
  const job: PrJob = {
    id: randomUUID(),
    status: "running",
    steps: (["access", "commit", "push", "create"] as const).map((name) => ({ name, state: "pending" })),
    base: prep.base,
    branch: prep.branch,
    startedAt: new Date().toISOString(),
    title: prep.title,
    body: prep.body,
  };
  jobs.set(key, job);
  void runPrJob(job, ctx, ws, runId, prep);
  return job;
}
