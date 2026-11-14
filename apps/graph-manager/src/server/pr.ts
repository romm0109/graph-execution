import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "./app.js";
import { FORGE_NAMES, clientFor, connFor, gitAuthArgs, type ForgeKind } from "./forges.js";
import type { WorkspaceHost } from "./host/types.js";
import { taskTitle, type RunDetail } from "./runs.js";
import { moveSpecToDoneGit } from "./specdone.js";
import type { UserStore } from "./store.js";

/** The workspace a Create PR works on: its id on the host, its forge and its path on the forge. */
export interface PrWorkspace {
  id: string;
  forge: string;
  fullPath: string;
}

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
  branch: string;
  title: string;
  body: string;
  base?: string;
}

export type PrStep = "checkout" | "commit" | "push" | "create";

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

/** Pathspec of everything but graph-execution's own folder. */
const RUNS_FOLDER = ".graph-execution";
const PATHSPEC = ["--", ".", `:(exclude)${RUNS_FOLDER}`];

const prKey = (ws: PrWorkspace, runId: string): string => `${ws.id}/${runId}`;
const isForge = (f: string): f is ForgeKind => f === "github" || f === "gitlab";

async function git(host: WorkspaceHost, ws: PrWorkspace, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await host.git(ws.id, args);
  return { ok: res.exitCode === 0, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

/** `specPath` (absolute, as state.json has it) relative to the repo's top level; undefined when it is outside. */
async function specRelOf(host: WorkspaceHost, ws: PrWorkspace, specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  if (!path.isAbsolute(specPath)) return specPath;
  const top = await git(host, ws, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.stdout === "") return undefined;
  // git prints the resolved top level (macOS: /private/var/…) while the engine may have recorded the spec through a
  // symlink (/var/…): compare the paths as given and resolved.
  const resolved = (p: string): Promise<string> => realpath(p).catch(() => p);
  const tops = [path.resolve(top.stdout), await resolved(top.stdout)];
  const specs = [specPath, await resolved(specPath)];
  for (const t of tops) {
    for (const sp of specs) {
      const rel = path.relative(t, sp);
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
    }
  }
  return undefined;
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

/** The first `# ` heading of the spec file, if it can be read. */
async function specTitle(host: WorkspaceHost, ws: PrWorkspace, specPath: string): Promise<string | undefined> {
  const rel = await specRelOf(host, ws, specPath);
  const text = rel === undefined ? undefined : await host.readFile(ws.id, rel);
  return text === undefined ? undefined : taskTitle(text);
}

async function suggest(ctx: AppContext, us: UserStore, host: WorkspaceHost, ws: PrWorkspace, runId: string, detail: RunDetail): Promise<PrSuggestion> {
  const state = detail.state;
  const title = (state && (await specTitle(host, ws, state.specPath))) ?? `graph-execution run ${runId}`;
  const tasks = (detail.graph?.nodes ?? []).map((n) => `- [x] ${n.id} ${n.title}`);
  const body = [...tasks, ...(tasks.length ? [""] : []), `Generated by graph-execution run ${runId}.`].join("\n");
  let base = state?.targetBranch;
  if (!base) {
    const cur = await git(host, ws, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (cur.ok && cur.stdout !== "" && cur.stdout !== "HEAD") base = cur.stdout;
  }
  if (!base && isForge(ws.forge)) {
    try {
      base = (await clientFor(ctx, us, ws.forge).getRepo(ws.fullPath)).defaultBranch;
    } catch {
      // fall through to main
    }
  }
  const suggestedBase = base ?? "main";
  return { branch: `gm/${runId}`, title, body, base: suggestedBase, bases: await remoteBranches(host, ws, suggestedBase) };
}

/** The branches of `origin` without the `origin/` prefix and without `HEAD`, `first` leading (and always present). */
async function remoteBranches(host: WorkspaceHost, ws: PrWorkspace, first: string): Promise<string[]> {
  const refs = await git(host, ws, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
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

/** Whether the run can get a PR now, or the PR it already has; undefined when the run does not exist. */
export async function prStatus(ctx: AppContext, us: UserStore, host: WorkspaceHost, ws: PrWorkspace, runId: string): Promise<PrStatus | undefined> {
  const detail = await host.runDetail(ws.id, runId);
  if (!detail) return undefined;
  const stored = us.get().prs[prKey(ws, runId)];
  if (stored) {
    const pr: PrRef = { url: stored.url, number: stored.number, branch: stored.branch };
    if (stored.base) pr.base = stored.base;
    return { pr, eligible: false };
  }
  const status = detail.state?.status ?? detail.summary.status;
  if (!detail.state || status !== "applied") return { eligible: false, reason: `the run has not landed (status ${status})` };
  const changes = await git(host, ws, ["--no-optional-locks", "status", "--porcelain", ...PATHSPEC]);
  if (!changes.ok || changes.stdout === "") return { eligible: false, reason: "no uncommitted changes in the workspace" };
  if (!isForge(ws.forge)) return { eligible: false, reason: `${ws.forge} is not a supported forge` };
  if (!connFor(ctx, us, ws.forge)) return { eligible: false, reason: `${FORGE_NAMES[ws.forge]} is not connected` };
  return { eligible: true, suggested: await suggest(ctx, us, host, ws, runId, detail) };
}

/** A Create PR that passed the checks: what the job needs to run. */
export interface PreparedPr {
  forge: ForgeKind;
  token: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** The run's spec, moved to a `done/` folder next to it in the PR commit. */
  specPath?: string;
}

/** The synchronous checks of Create PR, before any git command that changes something. Throws `PrError`. */
export async function preparePr(ctx: AppContext, us: UserStore, host: WorkspaceHost, ws: PrWorkspace, runId: string, input: PrInput): Promise<PreparedPr> {
  const status = await prStatus(ctx, us, host, ws, runId);
  if (!status) throw new PrError(404, "unknown run");
  if (!status.eligible || !status.suggested || !isForge(ws.forge)) throw new PrError(409, status.reason ?? "a pull request already exists for this run");
  const forge = ws.forge;
  const conn = connFor(ctx, us, forge);
  if (!conn) throw new PrError(409, `${FORGE_NAMES[forge]} is not connected`);

  const branch = input.branch.trim();
  // `--branch` also expands `@{-1}`; only a name that comes back unchanged is a plain, valid branch name.
  const valid = branch === "" || branch.startsWith("-") ? undefined : await git(host, ws, ["check-ref-format", "--branch", branch]);
  if (!valid?.ok || valid.stdout !== branch) throw new PrError(400, `invalid branch name: ${branch}`);
  const exists = await git(host, ws, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.ok) throw new PrError(409, `branch ${branch} already exists`);
  const base = input.base?.trim() || status.suggested.base;
  const specPath = (await host.runDetail(ws.id, runId))?.state?.specPath;
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

class StepFailed extends Error {}

/** Runs the steps of a prepared Create PR, updating `job` in place. Never throws: a failure ends in `status: "failed"`. */
export async function runPrJob(job: PrJob, ctx: AppContext, us: UserStore, host: WorkspaceHost, ws: PrWorkspace, runId: string, prep: PreparedPr): Promise<void> {
  const { forge, token, branch, base, title, body } = prep;
  const stepOf = (name: PrStep): PrJobStep => job.steps.find((s) => s.name === name)!;
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
    const res = await host.git(ws.id, args, onStderr ? { onStderr } : undefined);
    if (res.exitCode !== 0) fail(lastLine(res.stderr || res.stdout));
    return res.stdout.trim();
  };

  try {
    // The branch the workspace was on, to switch back to once the commit is on the PR branch (undefined when detached).
    const head = await git(host, ws, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const original = head.ok && head.stdout !== "" ? head.stdout : undefined;

    begin("checkout", branch);
    await run(["checkout", "-b", branch]);
    set("checkout", { state: "done" });

    begin("commit");
    // The spec moves to `done/` in the same commit, so the move is part of the PR; the title was taken from it already.
    const moved = await moveSpecToDoneGit((args) => host.git(ws.id, args), await specRelOf(host, ws, prep.specPath));
    // `git add` with the exclude pathspec fails when `.graph-execution/` is ignored (as in cloned workspaces), so stage
    // everything and unstage that folder again.
    await run(["add", "-A", "--", "."]);
    await run(["reset", "-q", "--", RUNS_FOLDER]);
    const staged = await run(["diff", "--cached", "--name-only"]);
    const files = staged === "" ? 0 : staged.split("\n").length;
    set("commit", { detail: `${files} ${files === 1 ? "file" : "files"} · “${title}”${moved ? ` · spec → ${moved}` : ""}` });
    const email = await git(host, ws, ["config", "user.email"]);
    const identity = email.stdout === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
    await run([...identity, "commit", "-m", title, "-m", body]);
    set("commit", { state: "done" });

    begin("push", "origin");
    await run([...gitAuthArgs(forge, token), "push", "--progress", "-u", "origin", branch], (chunk) => {
      const p = pushProgress(chunk);
      if (p !== undefined) set("push", { progress: p, detail: `origin · ${Math.round(p * 100)}%` });
    });
    set("push", { state: "done", detail: "origin", progress: 1 });
    // The commit stays on the PR branch; the workspace goes back to where the user was, so later runs don't build on it.
    // The working tree matches the commit, so the switch only fails on an unusual state; then the workspace stays put.
    if (original) await git(host, ws, ["checkout", "--quiet", original]);

    begin("create", `${FORGE_NAMES[forge]} ${forge === "gitlab" ? "MR" : "PR"} → ${base}`);
    const pr = await clientFor(ctx, us, forge)
      .createPullRequest({ fullPath: ws.fullPath, head: branch, base, title, body })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    await us.update((d) => {
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
export function currentJob(ctx: AppContext, ws: PrWorkspace, runId: string): PrJob | undefined {
  return registryOf(ctx).jobs.get(prKey(ws, runId));
}

/** Checks the input (throws `PrError`), then starts the job in the background and returns it. */
export async function startPr(ctx: AppContext, us: UserStore, host: WorkspaceHost, ws: PrWorkspace, runId: string, input: PrInput): Promise<PrJob> {
  const { jobs, starting } = registryOf(ctx);
  const key = prKey(ws, runId);
  if (jobs.get(key)?.status === "running" || starting.has(key)) throw new PrError(409, "a pull request is already being created");
  starting.add(key);
  let prep: PreparedPr;
  try {
    prep = await preparePr(ctx, us, host, ws, runId, input);
  } finally {
    starting.delete(key);
  }
  const job: PrJob = {
    id: randomUUID(),
    status: "running",
    steps: (["checkout", "commit", "push", "create"] as const).map((name) => ({ name, state: "pending" })),
    base: prep.base,
    branch: prep.branch,
    startedAt: new Date().toISOString(),
  };
  jobs.set(key, job);
  void runPrJob(job, ctx, us, host, ws, runId, prep);
  return job;
}
