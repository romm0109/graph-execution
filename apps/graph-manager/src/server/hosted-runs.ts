// Hosted runs (docs/prd/hosted-sessions.md, "Hosted runs"): every run of a remote session runs in its own run
// container. `start` clones the session branch (pushed first) into a container from `acquireRun` and starts the
// engine there; a background monitor waits for the run to end, opens its PR(s) from inside the container, archives
// the run folder and releases the container. The session's own files are never touched.
import { Readable } from "node:stream";
import { REVIEWERS_ENV } from "graph-execution/api";
import type { AppContext } from "./app.js";
import { clientFor, connFor, type ForgeKind } from "./forges.js";
import { RemoteWorkspaceHost } from "./host/remote.js";
import { HostError, type EngineStart, type GitAuth, type WorkspaceHost } from "./host/types.js";
import type { User } from "./identity.js";
import { PrError, prStatus, startPr, type PrJob, type PrWorkspace } from "./pr.js";
import { prKeyOf, relatedSection, withRelated } from "./project-pr.js";
import { DETAIL_FILE, type RunRow } from "./runarchive.js";
import { PROJECT_PREFIX } from "./runhome.js";
import { attachPr, type RunDetail, type RunSummary } from "./runs.js";
import { gzipTar, type TarEntry } from "./tar.js";
import type { HostedRunRecord, SessionRecord, UserStore } from "./store.js";

const ACTIVE = new Set<HostedRunRecord["state"]>(["starting", "running", "finishing"]);
export const isActive = (r: HostedRunRecord): boolean => ACTIVE.has(r.state);
const ENDED = new Set(["applied", "done", "failed", "aborted"]);
const PR_POLL_MS = 200;
const PR_WAIT_MS = 5 * 60_000;
/** Where the run owner's reviewers file goes in the run container's workspace (graph-execution's ignored folder). */
const REVIEWERS_REL = ".graph-execution/gm-reviewers.json";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isForge = (f: string): f is ForgeKind => f === "github" || f === "gitlab";

interface LiveRun {
  user: User;
  host: WorkspaceHost;
  ws: PrWorkspace;
  session: SessionRecord;
  runId: string;
}

export interface HostedStartInput {
  user: User;
  us: UserStore;
  session: SessionRecord;
  /** The run id the engine takes from GRAPH_EXECUTION_RUN_ID (`suite-…` for a project). */
  runId: string;
  args: string[];
  /** Added to the engine env (the user's agent keys; the run id is added here). */
  env: Record<string, string>;
  timeoutMs: number;
  auth?: GitAuth;
  /** One clone URL per repository of the session (`session.repos ?? [session.repo]`), when known. */
  cloneUrls: (string | undefined)[];
  /** A project session: its host, to copy the project folder's inputs (specs, tasks, contract) from. */
  sessionHost?: WorkspaceHost;
  /** Called once the run's record is stored (it counts toward the cap from then on): ends a `reserve`. */
  reserved?: () => void;
}

/** The forge workspace of a session: its id on the host, its forge and path (the first repository for a project). */
function prWorkspaceOf(session: SessionRecord): PrWorkspace {
  return { id: session.workspaceId, forge: session.repo.forge, fullPath: `${session.repo.owner}/${session.repo.name}` };
}

/** The status a run ended with, or undefined while it is still going. */
export function endedStatus(detail: RunDetail | undefined): string | undefined {
  if (!detail) return undefined;
  const status = detail.state?.status ?? detail.summary.status;
  if (ENDED.has(status)) return status;
  if (status === "interrupted" && detail.summary.live === false) return status;
  return undefined;
}

export class HostedRuns {
  private readonly ctx: AppContext;
  private readonly intervalMs: number;
  private readonly live = new Map<string, LiveRun>();
  private readonly finishing = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private readonly reattaching = new Map<string, Promise<void>>();

  constructor(opts: { ctx: AppContext; intervalMs?: number }) {
    this.ctx = opts.ctx;
    this.intervalMs = opts.intervalMs ?? 5000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
    await Promise.allSettled([...this.finishing.values()]);
  }

  // ---- records ----

  private async save(us: UserStore, runId: string, patch: Partial<HostedRunRecord> | null, init?: HostedRunRecord): Promise<void> {
    await us.update((d) => {
      if (patch === null) {
        delete d.hostedRuns[runId];
        return;
      }
      const cur = d.hostedRuns[runId] ?? init;
      if (cur) d.hostedRuns[runId] = { ...cur, ...patch };
    });
  }

  /** The active hosted runs of the user (the cap counts them). */
  active(us: UserStore): number {
    return Object.values(us.get().hostedRuns).filter(isActive).length;
  }

  /** Starts not stored yet, per user id: counted toward the cap so concurrent starts cannot pass it together. */
  private readonly pending = new Map<string, number>();

  /**
   * Checks the cap (`GM_MAX_RUN_CONTAINERS`) and holds a slot until the run's record is stored, synchronously, so two
   * starts arriving together cannot both pass it. Throws the 409; returns the release (idempotent).
   */
  reserve(user: User, us: UserStore, limit: number | undefined): () => void {
    const held = this.pending.get(user.id) ?? 0;
    if (limit !== undefined && this.active(us) + held >= limit) {
      throw new HostError(409, `You have ${limit} sandboxed runs. Wait for one to finish or stop it.`);
    }
    this.pending.set(user.id, held + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.pending.get(user.id) ?? 1) - 1;
      if (n <= 0) this.pending.delete(user.id);
      else this.pending.set(user.id, n);
    };
  }

  /** Whether the session has an active hosted run (a session ends only after it is finished and released). */
  async activeFor(user: User, sessionId: string): Promise<boolean> {
    const us = await this.ctx.store.forUser(user);
    return Object.values(us.get().hostedRuns).some((r) => r.sessionId === sessionId && isActive(r));
  }

  /** The record of a hosted run of the user on `workspaceId`. */
  async recordOf(user: User, workspaceId: string, runId: string): Promise<HostedRunRecord | undefined> {
    const us = await this.ctx.store.forUser(user);
    const r = Object.hasOwn(us.get().hostedRuns, runId) ? us.get().hostedRuns[runId] : undefined;
    return r && r.workspaceId === workspaceId ? r : undefined;
  }

  /** The run container's host while the run is active (and this server watches it). */
  hostOf(user: User, workspaceId: string, runId: string): WorkspaceHost | undefined {
    const run = this.live.get(runId);
    return run && run.user.id === user.id && run.ws.id === workspaceId ? run.host : undefined;
  }

  /** The summaries of the user's live hosted runs, read from their run containers. */
  async summaries(user: User, filter?: string): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const run of this.live.values()) {
      if (run.user.id !== user.id || (filter !== undefined && run.ws.id !== filter)) continue;
      try {
        out.push(...(await run.host.listRuns(run.ws.id)).filter((r) => r.id === run.runId));
      } catch (err) {
        console.error(`hosted run ${run.runId}: cannot list it: ${message(err)}`);
      }
    }
    return out;
  }

  // ---- start ----

  /** Starts a run in a new run container. A failed engine start answers its `EngineStart`; other failures throw. */
  async startRun(p: HostedStartInput): Promise<EngineStart> {
    const { user, us, session, runId } = p;
    const { provisioner } = this.ctx;
    const record: HostedRunRecord = {
      runId,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      branch: session.branch,
      state: "starting",
      startedAt: new Date().toISOString(),
    };
    try {
      await this.save(us, runId, {}, record);
    } finally {
      p.reserved?.();
    }
    let host: WorkspaceHost;
    try {
      host = await provisioner.acquireRun({ user, sessionId: session.id, runId });
    } catch (err) {
      await this.save(us, runId, null);
      throw err;
    }
    const undo = async (): Promise<void> => {
      await provisioner.releaseRun({ user, runId }).catch((e: unknown) => console.error(`hosted run ${runId}: release failed: ${message(e)}`));
      await this.save(us, runId, null);
    };
    let res: EngineStart;
    try {
      const auth = p.auth ? { auth: p.auth } : {};
      const branch = { existing: session.branch };
      if (session.projectId !== undefined) {
        const repos = session.repos ?? [session.repo];
        const cloneUrls = p.cloneUrls.every((u): u is string => u !== undefined) ? { cloneUrls: p.cloneUrls } : {};
        const project = us.get().projects[session.projectId];
        await host.prepare({ project: { id: session.projectId, ...(project ? { name: project.name } : {}), repos, ...cloneUrls }, branch, ...auth });
        if (p.sessionHost) await this.copyProjectInputs(p.sessionHost, host, session.workspaceId);
      } else {
        const cloneUrl = p.cloneUrls[0];
        await host.prepare({ repo: session.repo, branch, ...(cloneUrl ? { cloneUrl } : {}), ...auth });
      }
      const env: Record<string, string> = { ...p.env };
      // The run owner's reviewers, as a local run gets them (routes/runs.ts engineEnv).
      if (host instanceof RemoteWorkspaceHost) {
        const text = `${JSON.stringify({ reviewers: us.reviewers().filter((r) => r.enabled) }, null, 2)}\n`;
        const written = await host.writeFiles(session.workspaceId, { [REVIEWERS_REL]: text });
        const file = written[REVIEWERS_REL];
        if (file) env[REVIEWERS_ENV] = file;
      }
      res = await host.startEngine({ workspaceId: session.workspaceId, args: p.args, env, timeoutMs: p.timeoutMs });
    } catch (err) {
      await undo();
      throw err;
    }
    if (!res.ok) {
      await undo();
      return res;
    }
    await this.save(us, runId, { state: "running" });
    this.live.set(runId, { user, host, ws: prWorkspaceOf(session), session, runId });
    return res;
  }

  /** A project's inputs live only in the session's project folder (not on a forge): copied into the run's, committed. */
  private async copyProjectInputs(from: WorkspaceHost, to: WorkspaceHost, wsId: string): Promise<void> {
    if (!(to instanceof RemoteWorkspaceHost)) return;
    const files: Record<string, string> = {};
    const add = async (rel: string): Promise<void> => {
      const text = await from.readFile(wsId, rel);
      if (text !== undefined) files[rel] = text;
    };
    for (const top of ["contract.md", "test-plan.json"]) await add(top);
    for (const name of await from.listFiles(wsId, "specs")) await add(`specs/${name}`);
    let repos: string[];
    try {
      const pj = JSON.parse((await from.readFile(wsId, "project.json")) ?? "{}") as { repos?: { name?: unknown }[] };
      repos = (pj.repos ?? []).map((r) => r.name).filter((n): n is string => typeof n === "string");
    } catch {
      repos = [];
    }
    for (const repo of repos) for (const name of await from.listFiles(wsId, `tasks/${repo}`)) await add(`tasks/${repo}/${name}`);
    if (Object.keys(files).length === 0) return;
    await to.writeFiles(wsId, files);
    await to.git(wsId, ["add", "--", ...Object.keys(files)]);
    await to.git(wsId, ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost", "commit", "-q", "-m", "graph-manager: the session's project inputs"]);
  }

  // ---- restart ----

  /** After a control-plane restart: takes up the user's active runs again (acquireRun is idempotent for a running container). */
  reattach(user: User): Promise<void> {
    const pending = this.reattaching.get(user.id);
    if (pending) return pending;
    const run = this.doReattach(user).finally(() => this.reattaching.delete(user.id));
    this.reattaching.set(user.id, run);
    return run;
  }

  private async doReattach(user: User): Promise<void> {
    const us = await this.ctx.store.forUser(user);
    for (const r of Object.values(us.get().hostedRuns)) {
      if (!isActive(r) || this.live.has(r.runId) || this.finishing.has(r.runId)) continue;
      const session = us.get().sessions[r.sessionId];
      try {
        if (r.state === "starting") throw new Error("the run was still starting when graph-manager stopped");
        if (!session) throw new Error("the session is gone");
        const host = await this.ctx.provisioner.acquireRun({ user, sessionId: r.sessionId, runId: r.runId });
        const live: LiveRun = { user, host, ws: prWorkspaceOf(session), session, runId: r.runId };
        this.live.set(r.runId, live);
        // A run that was finishing starts its finish again (the PR job of the old process is gone).
        if (r.state === "finishing") await this.save(us, r.runId, { state: "running" });
      } catch (err) {
        console.error(`hosted run ${r.runId}: cannot reattach: ${message(err)}`);
        await this.save(us, r.runId, { state: "failed", error: message(err), endedAt: new Date().toISOString() }).catch(() => undefined);
        await this.ctx.provisioner.releaseRun({ user, runId: r.runId }).catch((e: unknown) => console.error(`hosted run ${r.runId}: release failed: ${message(e)}`));
      }
    }
  }

  // ---- monitor ----

  /** One poll of every live run; never overlaps a running one and never throws. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.poll()
      .catch((err: unknown) => console.error(`hosted runs: poll failed: ${message(err)}`))
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  private async poll(): Promise<void> {
    for (const run of [...this.live.values()]) {
      if (this.finishing.has(run.runId)) continue;
      let detail: RunDetail | undefined;
      try {
        detail = await run.host.runDetail(run.ws.id, run.runId);
      } catch (err) {
        console.error(`hosted run ${run.runId}: cannot read it: ${message(err)}`);
        continue;
      }
      const status = endedStatus(detail);
      if (status === undefined) continue;
      const done = this.finish(run, status, detail!).finally(() => this.finishing.delete(run.runId));
      this.finishing.set(run.runId, done);
    }
  }

  /** Resolves once every finish this server started is over (tests). */
  async settled(): Promise<void> {
    while (this.finishing.size > 0) await Promise.allSettled([...this.finishing.values()]);
  }

  /** PR (when applied), archive, release. Never throws. */
  private async finish(run: LiveRun, status: string, detail: RunDetail): Promise<void> {
    const { user, runId } = run;
    let us: UserStore | undefined;
    const patch: Partial<HostedRunRecord> = {};
    try {
      us = await this.ctx.store.forUser(user);
      await this.save(us, runId, { state: "finishing" });
      if (status === "applied") {
        try {
          Object.assign(patch, run.session.projectId !== undefined ? await this.projectPrs(us, run) : await this.repoPr(us, run));
        } catch (err) {
          patch.prError = message(err);
        }
        if (patch.prError) console.error(`hosted run ${runId}: no PR: ${patch.prError}`);
      } else if (status !== "done") {
        patch.error = detail.summary.failure ?? `the run ended ${status}`;
      }
      await this.save(us, runId, patch);
      try {
        await this.archive(us, run, status, patch.prUrl);
      } catch (err) {
        console.error(`hosted run ${runId}: archive failed: ${message(err)}`);
      }
    } catch (err) {
      console.error(`hosted run ${runId}: finish failed: ${message(err)}`);
      patch.error = patch.error ?? message(err);
    } finally {
      await this.ctx.provisioner.releaseRun({ user, runId }).catch((err: unknown) => console.error(`hosted run ${runId}: release failed: ${message(err)}`));
      this.live.delete(runId);
      const ok = status === "applied" || status === "done";
      if (us) {
        await this.save(us, runId, { state: ok && patch.error === undefined ? "done" : "failed", endedAt: new Date().toISOString() }).catch((err: unknown) =>
          console.error(`hosted run ${runId}: cannot save the record: ${message(err)}`),
        );
      }
    }
  }

  /** The existing Create PR, inside the run container: `gm/<runId>` into the session branch, spec moved to done/. */
  private async repoPr(us: UserStore, run: LiveRun): Promise<Partial<HostedRunRecord>> {
    const { host, ws, runId, session } = run;
    const status = await prStatus(this.ctx, us, host, ws, runId);
    if (!status) return { prError: "unknown run" };
    if (!status.eligible || !status.suggested) return { prError: status.reason ?? "the run cannot get a pull request" };
    const { title, body } = status.suggested;
    await this.save(us, runId, { prTitle: title, prBody: body });
    let job: PrJob;
    try {
      job = await startPr(this.ctx, us, host, ws, runId, { branch: `gm/${runId}`, title, body, base: session.branch });
    } catch (err) {
      if (err instanceof PrError) return { prError: err.message, prTitle: title, prBody: body };
      throw err;
    }
    const end = Date.now() + PR_WAIT_MS;
    while (job.status === "running" && Date.now() < end) await new Promise((r) => setTimeout(r, PR_POLL_MS));
    if (job.status === "done" && job.pr) return { prUrl: job.pr.url, prTitle: title, prBody: body };
    return { prError: job.status === "running" ? "creating the pull request timed out" : (job.error ?? "the pull request failed"), prTitle: title, prBody: body };
  }

  /** A project run: the agent commits and pushes `gm/<runId>` per changed repository; then one linked PR per repository. */
  private async projectPrs(us: UserStore, run: LiveRun): Promise<Partial<HostedRunRecord>> {
    const { host, runId, session } = run;
    const forge = session.repo.forge;
    if (!(host instanceof RemoteWorkspaceHost)) return { prError: "the run container cannot open pull requests" };
    const conn = connFor(this.ctx, us, forge);
    if (!conn) return { prError: `${forge === "github" ? "GitHub" : "GitLab"} is not connected` };
    const rows = await host.commitProjectRun(session.projectId!, runId, { forge, token: conn.token });
    const repos: NonNullable<HostedRunRecord["repos"]> = rows
      .filter((r) => r.changed || r.error !== undefined)
      .map((r) => ({ name: r.name, fullPath: r.fullPath, title: r.title, body: r.body, pushed: r.pushed, ...(r.error ? { error: r.error } : {}) }));
    if (repos.length === 0) return { prError: "no repo has changes to open a PR from", repos };
    await this.openProjectPrs(us, session.projectId!, runId, session.branch, forge, repos);
    return this.projectOutcome(repos);
  }

  private projectOutcome(repos: NonNullable<HostedRunRecord["repos"]>): Partial<HostedRunRecord> {
    const errors = repos.filter((r) => r.error !== undefined).map((r) => `${r.name}: ${r.error}`);
    const first = repos.find((r) => r.prUrl)?.prUrl;
    return { repos, ...(first ? { prUrl: first } : {}), ...(errors.length > 0 ? { prError: errors.join("; ") } : {}) };
  }

  /** Opens the missing PRs of the pushed repositories, then links every body to the others. Updates `repos` in place. */
  private async openProjectPrs(us: UserStore, projectId: string, runId: string, base: string, forge: ForgeKind, repos: NonNullable<HostedRunRecord["repos"]>): Promise<void> {
    const client = clientFor(this.ctx, us, forge);
    const members = repos.filter((r) => r.pushed);
    const others = (): { name: string; fullPath: string; number?: number; url?: string }[] =>
      members.map((r) => {
        const stored = us.get().prs[prKeyOf(projectId, runId, r.name)];
        return { name: r.name, fullPath: r.fullPath, ...(stored ? { number: stored.number, url: stored.url } : {}) };
      });
    for (const r of members) {
      const key = prKeyOf(projectId, runId, r.name);
      const stored = us.get().prs[key];
      if (stored) {
        r.prUrl = stored.url;
        continue;
      }
      try {
        const pr = await client.createPullRequest({ fullPath: r.fullPath, head: `gm/${runId}`, base, title: r.title, body: withRelated(r.body, relatedSection(r.name, others())) });
        await us.update((d) => {
          d.prs[key] = { url: pr.url, number: pr.number, branch: `gm/${runId}`, base, forge, createdAt: new Date().toISOString() };
        });
        r.prUrl = pr.url;
        delete r.error;
      } catch (err) {
        r.error = `create failed: ${message(err)}`;
      }
    }
    if (members.length === 0 || !members.every((r) => r.prUrl)) return;
    for (const r of members) {
      const key = prKeyOf(projectId, runId, r.name);
      const stored = us.get().prs[key];
      if (!stored || stored.linked) continue;
      if (members.length > 1) {
        try {
          await client.updatePullRequest({ fullPath: r.fullPath, number: stored.number, body: withRelated(r.body, relatedSection(r.name, others())) });
        } catch (err) {
          r.error = `linking failed: ${message(err)}`;
          continue;
        }
      }
      await us.update((d) => {
        const rec = d.prs[key];
        if (rec) rec.linked = true;
      });
    }
  }

  /**
   * Create PR again for an ended hosted run whose PR failed: only the forge calls, from the pushed `gm/<runId>`.
   * Throws `PrError` (409) with the forge's error.
   */
  async retryPr(user: User, record: HostedRunRecord): Promise<PrJob> {
    const us = await this.ctx.store.forUser(user);
    const session = us.get().sessions[record.sessionId];
    const startedAt = new Date().toISOString();
    if (record.repos) {
      const projectId = record.workspaceId.slice(PROJECT_PREFIX.length);
      const forge = session?.repo.forge ?? us.get().projects[projectId]?.repos[0]?.forge;
      if (!forge) throw new PrError(409, "the project's forge is not known any more");
      const repos = structuredClone(record.repos);
      await this.openProjectPrs(us, projectId, record.runId, record.branch, forge, repos);
      const outcome = this.projectOutcome(repos);
      await us.update((d) => {
        const rec = d.hostedRuns[record.runId];
        if (!rec) return;
        rec.repos = repos;
        if (outcome.prUrl) rec.prUrl = outcome.prUrl;
        if (outcome.prError) rec.prError = outcome.prError;
        else delete rec.prError;
      });
      if (outcome.prError) throw new PrError(409, outcome.prError);
      if (outcome.prUrl) await this.ctx.runArchive.record(user, record.workspaceId, record.runId, await this.archivedRow(user, record, outcome.prUrl)).catch(() => undefined);
      return doneJob(record, outcome.prUrl ?? "", 0, startedAt);
    }
    const forge = record.workspaceId.split("~")[0] ?? "";
    if (!isForge(forge)) throw new PrError(409, `${forge} is not a supported forge`);
    const fullPath = record.workspaceId.split("~").slice(1).join("/");
    const branch = `gm/${record.runId}`;
    let pr: { url: string; number: number };
    try {
      pr = await clientFor(this.ctx, us, forge).createPullRequest({
        fullPath,
        head: branch,
        base: record.branch,
        title: record.prTitle ?? `graph-execution run ${record.runId}`,
        body: record.prBody ?? "",
      });
    } catch (err) {
      throw new PrError(409, message(err));
    }
    await us.update((d) => {
      d.prs[`${record.workspaceId}/${record.runId}`] = { url: pr.url, number: pr.number, branch, base: record.branch, forge, createdAt: new Date().toISOString() };
      const rec = d.hostedRuns[record.runId];
      if (rec) {
        rec.prUrl = pr.url;
        delete rec.prError;
      }
    });
    await this.ctx.runArchive.record(user, record.workspaceId, record.runId, await this.archivedRow(user, record, pr.url)).catch(() => undefined);
    return doneJob(record, pr.url, pr.number, startedAt);
  }

  /** The archive row of an ended run with its new PR link (its summary from the archive). */
  private async archivedRow(user: User, record: HostedRunRecord, prUrl: string): Promise<RunRow> {
    const archived = await this.ctx.runArchive.get(user, record.workspaceId, record.runId);
    const summary: RunSummary = archived ? { ...archived.summary } : { workspaceId: record.workspaceId, type: "run", id: record.runId, status: "applied", kind: "archived", live: false };
    delete (summary as { archived?: true }).archived;
    attachPr(summary, (await this.ctx.store.forUser(user)).get().prs);
    return {
      status: summary.status,
      startedAt: summary.createdAt ?? record.startedAt,
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      prUrl,
      ...(archived?.state ? { state: archived.state } : {}),
      summary,
    };
  }

  /** The run's row (status, times, PR link, state) and its folder (from the run container) in the run archive. */
  private async archive(us: UserStore, run: LiveRun, status: string, prUrl: string | undefined): Promise<void> {
    const { user, host, ws, runId } = run;
    const detail = await host.runDetail(ws.id, runId);
    const summary: RunSummary = detail?.summary ?? { workspaceId: ws.id, type: runId.startsWith("suite-") ? "suite" : "run", id: runId, status, kind: "ended", live: false };
    summary.live = false;
    delete summary.viewUrl;
    attachPr(summary, us.get().prs);
    const record = us.get().hostedRuns[runId];
    await this.ctx.runArchive.record(user, ws.id, runId, {
      status: summary.status,
      startedAt: summary.createdAt ?? record?.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      ...(prUrl ? { prUrl } : {}),
      ...(detail?.state ? { state: detail.state } : {}),
      summary,
    });
    const entries: TarEntry[] = [];
    let skipped: string[] = [];
    if (host instanceof RemoteWorkspaceHost) {
      const folder = await host.runFolder(ws.id, runId);
      for (const f of folder?.files ?? []) entries.push({ path: f.path, content: f.content, mode: 0o600 });
      skipped = folder?.skipped ?? [];
    } else {
      const dir = `.graph-execution/${runId}`;
      for (const name of await host.listFiles(ws.id, dir)) {
        const text = await host.readFile(ws.id, `${dir}/${name}`);
        if (text !== undefined) entries.push({ path: name, content: Buffer.from(text), mode: 0o600 });
      }
    }
    const saved = { summary, state: detail?.state, graph: detail?.graph, tasks: detail?.tasks, view: detail?.view, skipped };
    entries.push({ path: DETAIL_FILE, content: Buffer.from(JSON.stringify(saved)), mode: 0o600 });
    await this.ctx.runArchive.saveFolder(user, ws.id, runId, Readable.from([gzipTar(entries, { uid: 0, gid: 0 })]));
  }
}

/** A finished Create PR job (every step done), as the PR panel shows it. */
function doneJob(record: HostedRunRecord, url: string, number: number, startedAt: string): PrJob {
  const branch = `gm/${record.runId}`;
  return {
    id: `hosted-${record.runId}`,
    status: "done",
    steps: (["checkout", "commit", "push", "create"] as const).map((name) => ({ name, state: "done" as const })),
    pr: { url, number, branch },
    base: record.branch,
    branch,
    startedAt,
  };
}
