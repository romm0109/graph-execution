// UI requests from agents in terminals (docs/prd/agent-tools.md "Agent requests", docs/prd/agent-supervisor.md "Agent
// requests and the web"): a tool queues one, the browser polls GET /api/agent-requests and acts on it. Kinds:
// `start-run` (open the Start run drawer), `open-run` (show a run), `open-graph`, `propose-graph`, and `refresh` (every
// tab re-fetches). All but `refresh` belong to a terminal and are acked once acted on; `refresh` is never acked and
// expires after 10 s. In memory: a restart drops them.
import { randomUUID } from "node:crypto";
import type { RunOptionsBody } from "./runoptions.js";

/** Requests nobody acked are dropped after a day. */
export const AGENT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** `refresh` requests are never acked: every tab acts on them, and they expire after 10 s. */
export const REFRESH_TTL_MS = 10_000;

export interface StartRunPrefill {
  /** Workspace-relative, `/` separators. */
  tasksDir: string;
  /** Workspace-relative, `/` separators. */
  spec: string;
  provider?: string;
  options?: RunOptionsBody;
}

/** Fields every agent request has. */
interface AgentRequestBase {
  id: string;
  workspaceId: string;
  /** The terminal's agent id when known (e.g. "claude"). */
  agent?: string;
  /** The terminal's title, for the toast. */
  terminalTitle?: string;
  createdAt: string;
}

/** A request from one terminal: acted on where that terminal is on screen (else from a toast), then acked. */
interface TerminalRequestBase extends AgentRequestBase {
  terminalId: string;
}

/** `open_start_run`: open the Start run drawer, prefilled. */
export interface StartRunRequest extends TerminalRequestBase {
  kind: "start-run";
  prefill: StartRunPrefill;
}
/** `open_run`: show a run (run pane on the Terminals page, else the run page). */
export interface OpenRunRequest extends TerminalRequestBase {
  kind: "open-run";
  runId: string;
}
/** `open_graph`: exactly one of `runId` / `tasksDir` (workspace-relative); `node` to focus. */
export interface OpenGraphRequest extends TerminalRequestBase {
  kind: "open-graph";
  runId?: string;
  tasksDir?: string;
  node?: string;
}
/** `propose_graph`: preview a task folder's graph with Approve / Reject; Approve opens Start run with `prefill`. */
export interface ProposeGraphRequest extends TerminalRequestBase {
  kind: "propose-graph";
  prefill: StartRunPrefill;
}
/** `refresh_ui`: every open tab re-fetches its data. No terminal; never acked; expires after REFRESH_TTL_MS. */
export interface RefreshRequest extends AgentRequestBase {
  kind: "refresh";
}

export type AgentRequest = StartRunRequest | OpenRunRequest | OpenGraphRequest | ProposeGraphRequest | RefreshRequest;
export type AgentRequestKind = AgentRequest["kind"];
/** What `add` takes: a request without `id` and `createdAt` (distributes over the union). */
export type NewAgentRequest<R extends AgentRequest = AgentRequest> = R extends AgentRequest ? Omit<R, "id" | "createdAt"> : never;

export class AgentRequests {
  private readonly items: AgentRequest[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Queues a request; it replaces a pending one of the same terminal and kind. `refresh` never replaces one. */
  add(r: NewAgentRequest): AgentRequest {
    if (r.kind !== "refresh") {
      const i = this.items.findIndex((x) => x.kind !== "refresh" && x.kind === r.kind && x.terminalId === r.terminalId);
      if (i >= 0) this.items.splice(i, 1);
    }
    const req = { ...r, id: randomUUID(), createdAt: new Date(this.now()).toISOString() } as AgentRequest;
    this.items.push(req);
    return req;
  }

  /** The pending requests, oldest first, without expired ones (refresh: 10 s, others: a day). */
  list(): AgentRequest[] {
    const now = this.now();
    for (let i = this.items.length - 1; i >= 0; i--) {
      const x = this.items[i]!;
      const ttl = x.kind === "refresh" ? REFRESH_TTL_MS : AGENT_REQUEST_TTL_MS;
      if (Date.parse(x.createdAt) < now - ttl) this.items.splice(i, 1);
    }
    return [...this.items];
  }

  /** A pending request by id (expired ones are gone), or undefined. */
  get(id: string): AgentRequest | undefined {
    return this.list().find((x) => x.id === id);
  }

  /** Removes a request; false when it is not pending or is a `refresh` request. */
  ack(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    if (this.items[i]!.kind === "refresh") return false;
    this.items.splice(i, 1);
    return true;
  }
}
