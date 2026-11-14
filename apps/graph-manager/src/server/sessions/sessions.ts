// Repo sessions (docs/prd/hosted-sessions.md, "Session lifecycle"): a repository with at least one open terminal of
// a user. Opening the first terminal on a repository starts its session; closing the last one ends it (asking first
// when the clone has uncommitted changes); ending waits for the session's live runs, then releases it.
import { randomBytes } from "node:crypto";
import { getUser, toUser } from "../accounts.js";
import type { AgentId } from "../agents.js";
import type { Db } from "../db/db.js";
import type { GitAuth, RepoRef, WorkspaceHost } from "../host/types.js";
import { localWorkspacePath } from "../host/local.js";
import type { User } from "../identity.js";
import type { Project } from "../projects.js";
import { PROJECT_PREFIX } from "../runhome.js";
import { projectOf, type Data, type SessionRecord, type SessionState, type Store, type UserStore } from "../store.js";
import type { TerminalInfo, TerminalManager } from "../terminals.js";
import { listWorkspaces } from "../workspaces.js";
import type { SessionProvisioner } from "./provisioner.js";

/** A session as the API shows it: the record and the ids of its terminals. */
export type SessionView = SessionRecord & { terminals: string[] };

export type CloseAction = "push" | "keep" | "discard";

/** What features add to the session flow (agent logins, the idle loop, ...). Every registered hook runs, in order. */
export interface SessionHooks {
  afterPrepare?(p: { user: User; session: SessionRecord; host: WorkspaceHost }): Promise<void>;
  beforeRelease?(p: { user: User; session: SessionRecord; host: WorkspaceHost }): Promise<void>;
  /** Variables added to the env of every session terminal. */
  terminalEnv?(user: User): Promise<Record<string, string>>;
}

/** What `SessionManager` passes to open a terminal (routes/terminals.ts `openTerminal`). */
export interface SessionTerminal {
  host: WorkspaceHost;
  workspaceId: string;
  cwd: string;
  agent?: AgentId;
  title?: string;
  cols?: number;
  rows?: number;
  sessionId: string;
  env?: Record<string, string>;
  /** A project session's terminal: cwd is the project folder, `GM_PROJECT_ID` is set. */
  project?: Project;
}

export interface OpenSession {
  /** One of `repo` and `project`: a repo session, or a project session (every repository of the project). */
  repo?: RepoRef;
  project?: Project;
  branch?: { new?: string } | { existing: string };
  agent?: AgentId;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface SessionManagerOptions {
  store: Store;
  provisioner: SessionProvisioner;
  terminals: TerminalManager;
  openTerminal: (user: User, p: SessionTerminal) => Promise<TerminalInfo>;
  localHost: WorkspaceHost;
  /** The workspaces folder of this server (terminal cwd shown, restore of an upgraded single-user install). */
  workspacesDir: string;
  /** The users table (restore). */
  db?: Db;
  maxSessions?: number;
  /** How often `end` asks whether the session's runs are still live. */
  pollMs?: number;
  liveRuns?: (host: WorkspaceHost, workspaceId: string) => Promise<number>;
  countUsers: () => Promise<number>;
  /** The clone URL and forge auth of a repository for `user` (their own forge token); `{}` when not known. */
  repoAccess?: (user: User, repo: RepoRef) => Promise<{ cloneUrl?: string; auth?: GitAuth }>;
  /** Whether a hosted run of the session (in its own run container) is still live: the session's end waits for it. */
  hostedRunLive?: (user: User, sessionId: string) => Promise<boolean>;
  /** The forge auth of a user's push. */
  forgeAuth?: (user: User, forge: RepoRef["forge"]) => Promise<GitAuth | undefined>;
  log?: (msg: string, err?: unknown) => void;
}

/** A request error with an HTTP status (the app's error handler answers `{ error: message }`). */
class SessionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const BRANCH_FORBIDDEN = /[\s~^:?*[\\]/;
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** `git check-ref-format --branch` rules, without running git. */
export function validBranchName(name: string): boolean {
  if (name === "" || name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.endsWith(".lock") || name.includes("..") || name.includes("@{") || name.includes("//") || BRANCH_FORBIDDEN.test(name) || hasControl(name)) return false;
  return name.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
}

/** `gm/<user>-<yyyymmdd>-<4 random [a-z0-9]>`. */
export function defaultBranchName(userId: string, now = new Date()): string {
  const who = userId.replace(/[^A-Za-z0-9._-]/g, "-");
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = [...randomBytes(4)].map((b) => alphabet[b % alphabet.length]).join("");
  return `gm/${who}-${day}-${suffix}`;
}

const sameRepo = (a: RepoRef, b: RepoRef): boolean => a.forge === b.forge && a.owner === b.owner && a.name === b.name;

/** Whether `s` is the session `body` opens: the project's session, or the repository's (never a project's). */
const isSessionOf = (s: SessionRecord, body: OpenSession): boolean =>
  body.project ? s.projectId === body.project.id : s.projectId === undefined && body.repo !== undefined && sameRepo(s.repo, body.repo);

export class SessionManager {
  private readonly hosts = new Map<string, WorkspaceHost>();
  /** Every known session of every user, kept in sync with the stores. */
  private readonly index = new Map<string, { user: User; session: SessionRecord }>();
  private readonly active = new Map<string, Date>();
  private readonly ending = new Map<string, Promise<void>>();
  private readonly hooks: SessionHooks[] = [];
  private readonly timers = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  private stopped = false;
  private readonly pollMs: number;
  private readonly liveRunsOf: (host: WorkspaceHost, workspaceId: string) => Promise<number>;

  constructor(private readonly opts: SessionManagerOptions) {
    this.pollMs = opts.pollMs ?? 5000;
    this.liveRunsOf = opts.liveRuns ?? (async (host, ws) => (await host.listRuns(ws)).filter((r) => r.kind === "live").length);
  }

  // ---- bookkeeping ----

  private log(msg: string, err?: unknown): void {
    if (this.opts.log) this.opts.log(msg, err);
    else console.error(err === undefined ? msg : `${msg}: ${err instanceof Error ? err.message : String(err)}`);
  }

  private async storeOf(user: User): Promise<UserStore> {
    return this.opts.store.forUser(user);
  }

  /** Refreshes the index from `us`. */
  private sync(us: UserStore): void {
    const user = us.user;
    for (const [id, e] of this.index) if (e.user.id === user.id) this.index.delete(id);
    for (const s of Object.values(us.get().sessions)) this.index.set(s.id, { user, session: s });
  }

  private async update(user: User, fn: (d: Data) => void): Promise<void> {
    const us = await this.storeOf(user);
    try {
      await us.update(fn);
    } finally {
      this.sync(us);
    }
  }

  private async record(user: User, id: string): Promise<SessionRecord | undefined> {
    const us = await this.storeOf(user);
    const s = Object.hasOwn(us.get().sessions, id) ? us.get().sessions[id] : undefined;
    return s ? structuredClone(s) : undefined;
  }

  private async mustRecord(user: User, id: string): Promise<SessionRecord> {
    const s = await this.record(user, id);
    if (!s) throw new SessionError(404, "session not found");
    return s;
  }

  touch(id: string): void {
    this.active.set(id, new Date());
  }

  async setState(user: User, id: string, state: SessionState, error?: string): Promise<void> {
    await this.update(user, (d) => {
      const s = d.sessions[id];
      if (!s) return;
      s.state = state;
      if (error === undefined) delete s.error;
      else s.error = error;
    });
    this.touch(id);
  }

  addHooks(h: SessionHooks): void {
    this.hooks.push(h);
  }

  private async runHooks(kind: "afterPrepare" | "beforeRelease", p: { user: User; session: SessionRecord; host: WorkspaceHost }): Promise<void> {
    for (const h of this.hooks) {
      const fn = h[kind];
      if (!fn) continue;
      try {
        await fn.call(h, p);
      } catch (err) {
        this.log(`session ${p.session.id}: ${kind} hook failed`, err);
      }
    }
  }

  private async hookEnv(user: User): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const h of this.hooks) {
      if (!h.terminalEnv) continue;
      try {
        Object.assign(env, await h.terminalEnv(user));
      } catch (err) {
        this.log("session terminalEnv hook failed", err);
      }
    }
    return env;
  }

  terminalIds(user: User, id: string): string[] {
    return this.opts.terminals
      .ofSession(id)
      .filter((t) => t.userId === user.id)
      .map((t) => t.id);
  }

  lastActiveAt(id: string): Date {
    const at = this.active.get(id);
    if (at) return at;
    const s = this.index.get(id)?.session;
    return s ? new Date(s.startedAt) : new Date(0);
  }

  all(): Array<{ user: User; session: SessionRecord }> {
    return [...this.index.values()].map((e) => ({ user: e.user, session: structuredClone(e.session) }));
  }

  private view(user: User, s: SessionRecord): SessionView {
    return { ...s, terminals: this.terminalIds(user, s.id) };
  }

  async list(user: User): Promise<SessionView[]> {
    const us = await this.storeOf(user);
    this.sync(us);
    return Object.values(us.get().sessions)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((s) => this.view(user, structuredClone(s)));
  }

  async get(user: User, id: string): Promise<SessionRecord | undefined> {
    return this.record(user, id);
  }

  async hostOf(user: User, session: SessionRecord): Promise<WorkspaceHost> {
    const cached = this.hosts.get(session.id);
    if (cached) return cached;
    const host = await this.opts.provisioner.acquire({ user, sessionId: session.id });
    this.hosts.set(session.id, host);
    return host;
  }

  async liveRuns(user: User, session: SessionRecord): Promise<number> {
    if (session.workspaceId === "") return 0;
    return this.liveRunsOf(await this.hostOf(user, session), session.workspaceId);
  }

  private cwdOf(workspaceId: string): string {
    return localWorkspacePath(this.opts.workspacesDir, workspaceId) ?? workspaceId;
  }

  private async spawn(user: User, session: SessionRecord, host: WorkspaceHost, p: { agent?: AgentId; cols?: number; rows?: number; title?: string }): Promise<TerminalInfo> {
    const env = await this.hookEnv(user);
    let project: Project | undefined;
    if (session.projectId !== undefined) {
      const pid = session.projectId;
      project = projectOf((await this.storeOf(user)).get(), pid) ?? { id: pid, name: pid, repos: [], workspaces: [], createdAt: session.startedAt };
    }
    const info = await this.opts.openTerminal(user, {
      ...(project ? { project } : {}),
      host,
      workspaceId: session.workspaceId,
      cwd: this.cwdOf(session.workspaceId),
      agent: p.agent,
      title: p.title,
      cols: p.cols,
      rows: p.rows,
      sessionId: session.id,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
    this.touch(session.id);
    return info;
  }

  // ---- open ----

  async open(user: User, body: OpenSession): Promise<{ sessionId: string; terminalId: string; branch: string }> {
    const { project } = body;
    const repos = project ? project.repos : body.repo ? [body.repo] : [];
    const repo = repos[0];
    if (!repo) throw new SessionError(400, project ? "the project has no repositories" : "pass repo or projectId");
    const label = project ? project.name : `${repo.owner}/${repo.name}`;
    const us = await this.storeOf(user);
    const existing = Object.values(us.get().sessions).find((s) => isSessionOf(s, body));
    if (existing) {
      const joined = await this.join(user, existing, label, body);
      return { sessionId: existing.id, terminalId: joined.id, branch: existing.branch };
    }

    let branch: { new: string } | { existing: string };
    if (body.branch && "existing" in body.branch) branch = { existing: body.branch.existing };
    else if (body.branch?.new !== undefined && body.branch.new !== "") branch = { new: body.branch.new };
    else branch = { new: defaultBranchName(user.id) };
    const branchName = "new" in branch ? branch.new : branch.existing;
    if (!validBranchName(branchName)) throw new SessionError(400, "branch: invalid branch name");

    const id = randomBytes(6).toString("hex");
    const max = this.opts.maxSessions;
    let joinInstead: SessionRecord | undefined;
    await this.update(user, (d) => {
      const again = Object.values(d.sessions).find((s) => isSessionOf(s, body));
      if (again) {
        joinInstead = again;
        return;
      }
      if (max !== undefined && Object.keys(d.sessions).length >= max) {
        throw new SessionError(409, `You have ${max} open repositories. Close all terminals of one to open another.`);
      }
      d.sessions[id] = {
        id,
        repo,
        ...(project ? { projectId: project.id, repos } : {}),
        workspaceId: "",
        branch: branchName,
        state: "starting",
        startedAt: new Date().toISOString(),
      };
    });
    if (joinInstead) {
      const joined = await this.join(user, joinInstead, label, body);
      return { sessionId: joinInstead.id, terminalId: joined.id, branch: joinInstead.branch };
    }
    this.touch(id);

    let host: WorkspaceHost;
    let prepared: { workspaceId: string; branch: string };
    try {
      const access = await Promise.all(repos.map(async (r) => (await this.opts.repoAccess?.(user, r)) ?? {}));
      const auth = access.find((a) => a.auth)?.auth;
      host = await this.opts.provisioner.acquire({ user, sessionId: id });
      this.hosts.set(id, host);
      this.refuseBranchSwitch(id, host, repos, branchName);
      if (project) {
        const cloneUrls = access.map((a) => a.cloneUrl ?? "");
        prepared = await host.prepare({
          project: { id: project.id, name: project.name, repos, ...(cloneUrls.every((u) => u !== "") ? { cloneUrls } : {}) },
          branch,
          ...(auth ? { auth } : {}),
        });
      } else {
        const one = access[0] ?? {};
        prepared = await host.prepare({ repo, branch, ...(one.cloneUrl ? { cloneUrl: one.cloneUrl } : {}), ...(one.auth ? { auth: one.auth } : {}) });
      }
    } catch (err) {
      this.hosts.delete(id);
      this.active.delete(id);
      await this.update(user, (d) => {
        delete d.sessions[id];
      }).catch((e: unknown) => this.log(`session ${id}: cannot delete the record`, e));
      await this.opts.provisioner.release({ user, sessionId: id }).catch((e: unknown) => this.log(`session ${id}: release failed`, e));
      throw err;
    }

    const draft = { ...(await this.mustRecord(user, id)), workspaceId: prepared.workspaceId, branch: prepared.branch };
    await this.runHooks("afterPrepare", { user, session: draft, host });
    await this.update(user, (d) => {
      const s = d.sessions[id];
      if (s) {
        s.workspaceId = prepared.workspaceId;
        s.branch = prepared.branch;
        s.state = "live";
      }
      if (!d.ownedWorkspaces.includes(prepared.workspaceId)) d.ownedWorkspaces.push(prepared.workspaceId);
    });
    this.touch(id);
    const session = await this.mustRecord(user, id);
    const info = await this.spawn(user, session, host, body);
    return { sessionId: id, terminalId: info.id, branch: session.branch };
  }

  /**
   * 409 when another open session (of any user) shares this host's clone of one of `repos` on another branch: with the
   * one local host, a prepare would switch the branch under that live session (the branch is fixed while it is live).
   */
  private refuseBranchSwitch(id: string, host: WorkspaceHost, repos: RepoRef[], branch: string): void {
    for (const { session: o } of this.index.values()) {
      if (o.id === id || o.branch === branch || this.hosts.get(o.id) !== host) continue;
      const theirs = o.repos ?? [o.repo];
      const clash = repos.find((r) => theirs.some((t) => sameRepo(r, t)));
      if (clash) {
        throw new SessionError(409, `${clash.owner}/${clash.name} is open in another session on branch ${o.branch}. Close that session first.`);
      }
    }
  }

  /** A new terminal in the user's existing session on the same repository. */
  private async join(user: User, s: SessionRecord, label: string, p: { agent?: AgentId; cols?: number; rows?: number; title?: string }): Promise<TerminalInfo> {
    if (s.state === "starting") throw new SessionError(409, `${label} is still opening. Try again in a moment.`);
    if (s.state === "ending" || s.state === "save-failed") throw new SessionError(409, `${label} is closing. Try again when it has closed.`);
    return this.openTerminal(user, s.id, p);
  }

  async openTerminal(user: User, sessionId: string, p: { agent?: AgentId; cols?: number; rows?: number; title?: string }): Promise<TerminalInfo> {
    const s = await this.mustRecord(user, sessionId);
    if (s.state !== "live" && s.state !== "asking") throw new SessionError(409, `session is ${s.state}`);
    if (s.state === "asking") await this.setState(user, sessionId, "live");
    const host = await this.hostOf(user, s);
    return this.spawn(user, s, host, p);
  }

  // ---- close ----

  async lastTerminalClosed(user: User, id: string): Promise<{ ask?: { changes: string[] } }> {
    this.touch(id);
    const s = await this.record(user, id);
    if (!s || s.state !== "live") return {};
    const changes = await (await this.hostOf(user, s)).changes(s.workspaceId);
    // A terminal opened meanwhile keeps the session.
    const now = await this.record(user, id);
    if (!now || now.state !== "live" || this.terminalIds(user, id).length > 0) return {};
    if (changes.length === 0) {
      await this.setState(user, id, "ending");
      void this.end(user, id);
      return {};
    }
    await this.setState(user, id, "asking");
    return { ask: { changes } };
  }

  /** Closes every terminal of the session, then ends it like the last terminal closing (`DELETE /api/sessions/:id`). */
  async closeSession(user: User, id: string): Promise<{ ask?: { changes: string[] } }> {
    const s = await this.mustRecord(user, id);
    for (const t of this.terminalIds(user, id)) this.opts.terminals.remove(t);
    if (s.state === "asking") {
      return { ask: { changes: await (await this.hostOf(user, s)).changes(s.workspaceId) } };
    }
    return this.lastTerminalClosed(user, id);
  }

  async close(user: User, id: string, action: CloseAction): Promise<{ session: SessionView; skipped?: string[] }> {
    const s = await this.mustRecord(user, id);
    const refuse = (): never => {
      throw new SessionError(409, `session is ${s.state}`);
    };
    const current = async (): Promise<SessionView> => {
      const now = await this.record(user, id);
      return this.view(user, now ?? { ...s, state: "ending" });
    };
    if (action === "keep") {
      if (s.state !== "asking") refuse();
      await this.setState(user, id, "live");
      return { session: await current() };
    }
    if (s.state !== "asking" && s.state !== "save-failed") refuse();
    if (this.terminalIds(user, id).length > 0) throw new SessionError(409, "session has open terminals");
    const host = await this.hostOf(user, s);
    await this.setState(user, id, "ending");
    if (action === "push") {
      let res: { pushed: boolean; skipped: string[]; error?: string };
      try {
        const auth = await this.opts.forgeAuth?.(user, s.repo.forge).catch(() => undefined);
        res = await host.save({ workspaceId: s.workspaceId, branch: s.branch, message: `graph-manager: save session ${id}`, ...(auth ? { auth } : {}) });
      } catch (err) {
        res = { pushed: false, skipped: [], error: err instanceof Error ? err.message : String(err) };
      }
      if (!res.pushed) {
        await this.setState(user, id, "save-failed", res.error ?? "push failed");
        return { session: await current(), skipped: res.skipped };
      }
      void this.end(user, id);
      return { session: await current(), skipped: res.skipped };
    }
    try {
      await host.discard(s.workspaceId);
    } catch (err) {
      await this.setState(user, id, s.state, err instanceof Error ? err.message : String(err));
      throw err;
    }
    void this.end(user, id);
    return { session: await current() };
  }

  // ---- end ----

  /** Waits for the session's live runs, then releases it and deletes the record. One pending end per session. */
  end(user: User, id: string): Promise<void> {
    const pending = this.ending.get(id);
    if (pending) return pending;
    const run = this.doEnd(user, id).finally(() => this.ending.delete(id));
    this.ending.set(id, run);
    return run;
  }

  private async doEnd(user: User, id: string): Promise<void> {
    try {
      const first = await this.record(user, id);
      if (!first) return;
      if (first.state !== "ending" || first.error !== undefined) await this.setState(user, id, "ending");
      while (!this.stopped) {
        const s = await this.record(user, id);
        if (!s) return;
        let live: number;
        try {
          live = await this.liveRuns(user, s);
        } catch (err) {
          this.log(`session ${id}: cannot list runs`, err);
          live = 0;
        }
        if (live === 0 && (await this.opts.hostedRunLive?.(user, id).catch(() => false))) live = 1;
        if (live === 0) break;
        await this.sleep(this.pollMs);
      }
      if (this.stopped) return;
      const s = await this.record(user, id);
      if (!s) return;
      await this.release(user, s);
    } catch (err) {
      this.log(`session ${id}: end failed`, err);
    }
  }

  private async release(user: User, s: SessionRecord): Promise<void> {
    const host = this.hosts.get(s.id) ?? this.opts.localHost;
    await this.runHooks("beforeRelease", { user, session: s, host });
    try {
      await this.opts.provisioner.release({ user, sessionId: s.id });
    } catch (err) {
      this.log(`session ${s.id}: release failed`, err);
      await this.setState(user, s.id, "ending", `release failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.hosts.delete(s.id);
    this.active.delete(s.id);
    await this.update(user, (d) => {
      delete d.sessions[s.id];
    });
  }

  /** Ends every session of a user without asking (no push): the gateway disabled or deleted them. */
  async endAllOf(userId: string): Promise<void> {
    for (const t of this.opts.terminals.listFor(userId)) this.opts.terminals.remove(t.id);
    for (const { user, session } of this.all()) {
      if (user.id !== userId) continue;
      if (session.state === "starting") continue;
      try {
        await this.release(user, session);
      } catch (err) {
        this.log(`session ${session.id}: cannot end`, err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          this.timers.delete(entry);
          resolve();
        }, ms),
        resolve,
      };
      entry.timer.unref();
      this.timers.add(entry);
    });
  }

  /** Resolves when no `end` is pending (tests). */
  async settled(): Promise<void> {
    while (this.ending.size > 0) await Promise.allSettled([...this.ending.values()]);
  }

  /** Stops the end loops (app close); their sessions stay `ending` and resume at the next `restore`. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) {
      clearTimeout(t.timer);
      t.resolve();
    }
    this.timers.clear();
    await this.settled();
  }

  // ---- restart ----

  /** After a restart: drops sessions that never finished opening and resumes the pending ends. */
  async restore(): Promise<void> {
    const db = this.opts.db;
    if (!db) return;
    const rows = await db.query<{ id: string }>("SELECT id FROM users");
    const users: User[] = [];
    for (const r of rows) {
      const row = await getUser(db, r.id);
      if (row) users.push(toUser(row));
    }
    for (const user of users) {
      const us = await this.storeOf(user);
      const starting = Object.values(us.get().sessions).filter((s) => s.state === "starting");
      if (starting.length > 0) {
        await us.update((d) => {
          for (const s of starting) delete d.sessions[s.id];
        });
      }
      this.sync(us);
      for (const s of Object.values(us.get().sessions)) if (s.state === "ending") void this.end(user, s.id);
    }
    if (users.length === 1 && (await this.opts.countUsers()) === 1) {
      const ids = (await listWorkspaces(this.opts.workspacesDir)).map((w) => w.id);
      const user = users[0]!;
      const us = await this.storeOf(user);
      if (ids.some((wid) => !us.get().ownedWorkspaces.includes(wid))) {
        await us.update((d) => {
          for (const wid of ids) if (!d.ownedWorkspaces.includes(wid)) d.ownedWorkspaces.push(wid);
        });
      }
    }
  }

  // ---- ownership ----

  /** Records that `user` made the clone `workspaceId` (e.g. `POST /api/workspaces`). */
  async addOwned(user: User, workspaceId: string): Promise<void> {
    const us = await this.storeOf(user);
    if (us.get().ownedWorkspaces.includes(workspaceId)) return;
    await us.update((d) => {
      if (!d.ownedWorkspaces.includes(workspaceId)) d.ownedWorkspaces.push(workspaceId);
    });
  }

  async ownsWorkspace(user: User, workspaceId: string): Promise<boolean> {
    if (workspaceId.startsWith(PROJECT_PREFIX)) return true;
    if ((await this.opts.countUsers()) <= 1) return true;
    const d = (await this.storeOf(user)).get();
    return d.ownedWorkspaces.includes(workspaceId) || Object.values(d.sessions).some((s) => s.workspaceId === workspaceId);
  }

  async hostFor(user: User, workspaceId: string): Promise<WorkspaceHost> {
    if (!(await this.ownsWorkspace(user, workspaceId))) throw new SessionError(404, "unknown workspace");
    const s = Object.values((await this.storeOf(user)).get().sessions).find((x) => x.workspaceId === workspaceId && x.state !== "starting");
    return s ? this.hostOf(user, structuredClone(s)) : this.opts.localHost;
  }
}
