// Where a new session runs (GM_SESSION_RUNTIME): `auto` = local with one account, Docker with two or more, decided
// each time a session is opened. A session keeps the provisioner that started it, so a session started local keeps
// running local after a second account appears.
import type { Config } from "../config.js";
import type { User } from "../identity.js";
import type { WorkspaceHost } from "../host/types.js";
import type { SessionProvisioner } from "./provisioner.js";

export type SessionRuntime = NonNullable<Config["sessionRuntime"]>;

export function chooseRuntime(setting: SessionRuntime, accounts: number): "local" | "docker" {
  return setting === "auto" ? (accounts >= 2 ? "docker" : "local") : setting;
}

export class RuntimeProvisioner implements SessionProvisioner {
  private readonly sessions = new Map<string, SessionProvisioner>();
  private readonly runs = new Map<string, SessionProvisioner>();

  constructor(private readonly p: { setting: SessionRuntime; countUsers: () => Promise<number>; local: SessionProvisioner; docker: SessionProvisioner }) {}

  async acquire(a: { user: User; sessionId: string }): Promise<WorkspaceHost> {
    let prov = this.sessions.get(a.sessionId);
    if (!prov) prov = chooseRuntime(this.p.setting, await this.p.countUsers()) === "docker" ? this.p.docker : this.p.local;
    const host = await prov.acquire(a);
    this.sessions.set(a.sessionId, prov);
    return host;
  }

  async release(a: { user: User; sessionId: string }): Promise<void> {
    const prov = this.sessions.get(a.sessionId);
    if (prov) {
      await prov.release(a);
    } else {
      // Not started by this process (a restart): the docker release ignores a missing container.
      await this.p.docker.release(a);
      await this.p.local.release(a);
    }
    this.sessions.delete(a.sessionId);
  }

  async acquireRun(a: { user: User; sessionId: string; runId: string }): Promise<WorkspaceHost> {
    const prov = this.sessions.get(a.sessionId) ?? this.p.docker;
    const host = await prov.acquireRun(a);
    this.runs.set(a.runId, prov);
    return host;
  }

  async releaseRun(a: { user: User; runId: string }): Promise<void> {
    await (this.runs.get(a.runId) ?? this.p.docker).releaseRun(a);
    this.runs.delete(a.runId);
  }

  /** Which runtime a session runs on, when this process started it. */
  runtimeOf(sessionId: string): "local" | "docker" | undefined {
    const prov = this.sessions.get(sessionId);
    return prov === undefined ? undefined : prov === this.p.docker ? "docker" : "local";
  }
}
