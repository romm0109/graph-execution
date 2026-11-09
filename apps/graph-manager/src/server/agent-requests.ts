// UI requests from agents in terminals (docs/prd/agent-tools.md "Agent requests"): a tool queues one, the browser polls
// GET /api/agent-requests, acts on it (e.g. opens the Start run popup) and acks it. In memory: a restart drops them.
import { randomUUID } from "node:crypto";
import type { RunOptionsBody } from "./runoptions.js";

/** Requests nobody acked are dropped after a day. */
export const AGENT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface StartRunPrefill {
  /** Workspace-relative, `/` separators. */
  tasksDir: string;
  /** Workspace-relative, `/` separators. */
  spec: string;
  provider?: string;
  options?: RunOptionsBody;
}

export interface AgentRequest {
  id: string;
  kind: "start-run";
  terminalId: string;
  workspaceId: string;
  /** The terminal's agent id when known (e.g. "claude"). */
  agent?: string;
  /** The terminal's title, for the toast. */
  terminalTitle?: string;
  createdAt: string;
  prefill: StartRunPrefill;
}

export class AgentRequests {
  private readonly items: AgentRequest[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Queues a request; it replaces a pending one of the same terminal. */
  add(r: Omit<AgentRequest, "id" | "createdAt">): AgentRequest {
    const i = this.items.findIndex((x) => x.terminalId === r.terminalId);
    if (i >= 0) this.items.splice(i, 1);
    const req: AgentRequest = { ...r, id: randomUUID(), createdAt: new Date(this.now()).toISOString() };
    this.items.push(req);
    return req;
  }

  /** The pending requests, oldest first, without expired ones. */
  list(): AgentRequest[] {
    const cutoff = this.now() - AGENT_REQUEST_TTL_MS;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (Date.parse(this.items[i]!.createdAt) < cutoff) this.items.splice(i, 1);
    }
    return [...this.items];
  }

  /** Removes a request; false when it is not pending. */
  ack(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
}
