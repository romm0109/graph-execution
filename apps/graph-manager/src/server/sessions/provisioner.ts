// Where sessions run (docs/prd/hosted-sessions.md, "SessionProvisioner"): locally every session shares the one
// LocalWorkspaceHost; a hosted deployment gives each session (and each sandboxed run) its own container.
import type { User } from "../identity.js";
import type { WorkspaceHost } from "../host/types.js";

export interface SessionProvisioner {
  /** A session container for one repository or one project. Must be idempotent per sessionId (graph-manager calls it again after a restart). */
  acquire(p: { user: User; sessionId: string }): Promise<WorkspaceHost>;
  release(p: { user: User; sessionId: string }): Promise<void>;
  /** A run container for a sandboxed run (hosted only). */
  acquireRun(p: { user: User; sessionId: string; runId: string }): Promise<WorkspaceHost>;
  releaseRun(p: { user: User; runId: string }): Promise<void>;
}

/** The open-source provisioner: every session runs on the one shared local host, and the clone stays on disk. */
export class LocalProvisioner implements SessionProvisioner {
  constructor(private readonly host: WorkspaceHost) {}

  async acquire(): Promise<WorkspaceHost> {
    return this.host;
  }

  async release(): Promise<void> {}

  async acquireRun(): Promise<WorkspaceHost> {
    throw new Error("LocalProvisioner has no run containers: local sandboxed runs use Docker");
  }

  async releaseRun(): Promise<void> {}
}
