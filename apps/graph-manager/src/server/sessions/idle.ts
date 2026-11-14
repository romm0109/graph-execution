// Idle sessions (docs/prd/hosted-sessions.md, "Idle"): with GM_SESSION_IDLE_MINUTES set, a session nobody has used
// for that long (no terminal input or output, no live run) closes its terminals, pushes its uncommitted changes to
// `gm/backup/<session id>` (never the session branch) and ends without asking. The user gets a notice.
import { randomBytes } from "node:crypto";
import type { GitAuth, RepoRef } from "../host/types.js";
import type { User } from "../identity.js";
import type { SessionRecord, Store } from "../store.js";
import type { TerminalManager } from "../terminals.js";
import type { SessionManager } from "./sessions.js";

export interface IdleMonitorOptions {
  sessions: SessionManager;
  terminals: TerminalManager;
  store: Store;
  /** Minutes without activity after which a session ends. */
  minutes: number;
  /** How often `check` runs once started; 60 s by default. */
  checkMs?: number;
  /** The forge auth of the backup push (the user's own forge token). */
  forgeAuth?: (user: User, forge: RepoRef["forge"]) => Promise<GitAuth | undefined>;
  log?: (msg: string, err?: unknown) => void;
}

export const backupBranch = (sessionId: string): string => `gm/backup/${sessionId}`;

export class IdleMonitor {
  private timer: NodeJS.Timeout | undefined;
  /** Sessions a pass is handling right now. */
  private readonly handling = new Set<string>();
  private running: Promise<void> | undefined;

  constructor(private readonly o: IdleMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.check().finally(() => (this.running = undefined));
    }, this.o.checkMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private log(msg: string, err?: unknown): void {
    if (this.o.log) this.o.log(msg, err);
    else console.error(err === undefined ? msg : `${msg}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** The last activity of a session: its own bookkeeping and the input/output of its terminals. */
  private lastActivity(sessionId: string): number {
    let last = this.o.sessions.lastActiveAt(sessionId).getTime();
    for (const t of this.o.terminals.ofSession(sessionId)) {
      for (const at of [t.lastInputAt, t.lastOutputAt, t.createdAt]) {
        if (at !== undefined) last = Math.max(last, Date.parse(at));
      }
    }
    return last;
  }

  /** One pass; `now` is injectable for tests. Resolves when every idle session handled in this pass has been saved (not necessarily released). */
  async check(now: Date = new Date()): Promise<void> {
    const limit = this.o.minutes * 60_000;
    const work: Array<Promise<void>> = [];
    for (const { user, session } of this.o.sessions.all()) {
      if (session.state !== "live" && session.state !== "asking") continue;
      if (this.handling.has(session.id)) continue;
      if (now.getTime() - this.lastActivity(session.id) < limit) continue;
      this.handling.add(session.id);
      work.push(
        this.handle(user, session, now)
          .catch((err: unknown) => this.log(`session ${session.id}: idle close failed`, err))
          .finally(() => this.handling.delete(session.id)),
      );
    }
    await Promise.all(work);
  }

  private async handle(user: User, session: SessionRecord, now: Date): Promise<void> {
    const { sessions, terminals } = this.o;
    if ((await sessions.liveRuns(user, session)) > 0) return;
    // Still idle and still open after the await?
    const current = await sessions.get(user, session.id);
    if (!current || (current.state !== "live" && current.state !== "asking")) return;
    if (now.getTime() - this.lastActivity(session.id) < this.o.minutes * 60_000) return;

    for (const t of terminals.ofSession(session.id)) terminals.remove(t.id);

    const repo = current.projectId !== undefined ? `project ${current.projectId}` : `${current.repo.owner}/${current.repo.name}`;
    const n = this.o.minutes;
    const branch = backupBranch(current.id);
    const host = await sessions.hostOf(user, current);
    const changes = current.workspaceId === "" ? [] : await host.changes(current.workspaceId);
    let text: string;
    if (changes.length > 0) {
      await sessions.setState(user, current.id, "ending");
      let res: { pushed: boolean; skipped: string[]; error?: string };
      try {
        const auth = await this.o.forgeAuth?.(user, current.repo.forge).catch(() => undefined);
        res = await host.save({ workspaceId: current.workspaceId, branch, message: `graph-manager: save session ${current.id}`, ...(auth ? { auth } : {}) });
      } catch (err) {
        res = { pushed: false, skipped: [], error: err instanceof Error ? err.message : String(err) };
      }
      if (!res.pushed) {
        const error = res.error ?? "push failed";
        await sessions.setState(user, current.id, "save-failed", error);
        await this.notify(user, now, `Your session on ${repo} was idle for ${n} minutes, but saving its changes to ${branch} failed: ${error}. Open it to retry or discard.`);
        return;
      }
      text = `Your session on ${repo} was closed after ${n} minutes idle. Changes were saved to branch ${branch}.`;
    } else {
      text = `Your session on ${repo} was closed after ${n} minutes idle.`;
    }
    await this.notify(user, now, text);
    void sessions.end(user, current.id);
  }

  private async notify(user: User, now: Date, text: string): Promise<void> {
    const us = await this.o.store.forUser(user);
    await us.update((d) => {
      d.notices.push({ id: randomBytes(6).toString("hex"), text, createdAt: now.toISOString() });
    });
  }
}
