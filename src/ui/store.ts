import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { AGENT_NODE, GATE_NODE, MERGE_NODE } from "../runner/nodes.js";
import type { Finding } from "../review/report.js";
import type { NodeChanges, PhaseChange, ReviewAgent, RunEmitter, RunEnd, RunEventMap } from "../runner/events.js";

/** `done` is a review-phase agent's success, `merged` a task's; `skipped` a pipeline step that was not needed. */
export type NodeStatus =
  | "pending"
  | "running"
  | "validating"
  | "fixing"
  | "merging"
  | "merged"
  | "done"
  | "failed"
  | "skipped";

/** The live tester's verdict per test plan case in the latest finished review round. */
export interface TestPlanView {
  round: number;
  cases: Array<{
    id: string;
    title?: string;
    priority?: "must" | "should";
    verdict: "pass" | "fail" | "blocked";
    evidence?: string;
  }>;
}

export interface NodeView {
  status: NodeStatus;
  /** The current attempt, 0 before the task starts. */
  attempt: number;
  /** The attempt budget, for `retry N/M`. */
  attempts: number;
  /** The agent label of this node: the task id, or the review agent's current run (`code-r1`). */
  label: string;
  /** The validation fix round (`fixing`), or the one just finished (`validating` again). */
  round?: number;
  /** The validation fix round budget (`config.validationRounds`). */
  rounds?: number;
  /** What the node changed so far; absent before its first snapshot. */
  changes?: NodeChanges;
  /** The tester's test plan verdicts; set by `review:end`. */
  testPlan?: TestPlanView;
  /** ms epoch, the first time the node became running. */
  startedAt?: number;
  /** ms epoch, when the node reached done/merged/failed/skipped; cleared when it runs again. */
  endedAt?: number;
}

const FINISHED: ReadonlySet<NodeStatus> = new Set(["done", "merged", "failed", "skipped"]);

/** Applies `change` to `node` and stamps `startedAt` (first run only) and `endedAt` from the new status. */
function stamped(node: NodeView, change: Partial<NodeView>, now = Date.now()): NodeView {
  const next = { ...node, ...change };
  if (next.status === "running" && next.startedAt === undefined) next.startedAt = now;
  if (FINISHED.has(next.status)) {
    if (next.endedAt === undefined || node.status !== next.status) next.endedAt = now;
  } else if (next.endedAt !== undefined) delete next.endedAt;
  return next;
}

/** One line of the run's log, for the events panel. */
export interface RunEvent {
  /** `HH:MM:SS` */
  time: string;
  text: string;
}

/** How many run events the store keeps. */
export const EVENTS_KEPT = 20;

/** The review-phase nodes under the task graph, in display order. */
export const REVIEW_AGENTS: readonly ReviewAgent[] = ["gateFixer", "reviewer", "tester", "fixer"];

export interface ViewState {
  /** Task nodes by task id. */
  nodes: Record<string, NodeView>;
  /** The code reviewer, live tester and fixer nodes, and the validation fixer of the gate before the review. */
  agents: Record<ReviewAgent, NodeView>;
  /** The validation gate before the first review. */
  gate: NodeView;
  /** The final merge into the starting branch. */
  merge: NodeView;
  phase: PhaseChange;
  /** Set once the run is over: the final summary shows under the graph. */
  summary?: RunEnd;
  /** The latest lines of the run's own log (not the agents' output), oldest first. */
  events: RunEvent[];
  /** Nodes the run waits to retry (`retry:available`); empty while it is going. */
  retryable: string[];
  /** The run also offers to merge what was done so far into the starting branch (`retry:available`). */
  mergeable: boolean;
  /** Set while the run waits for the human's review (`review:waiting`); `waiting` turns false on `review:decided`. */
  review?: {
    waiting: boolean;
    round: number;
    reviewRound?: number;
    blocking: Finding[];
    comments?: { total: number; open: number; addressed: number };
    /** The human's last decision, once the run left the wait. */
    decision?: "apply" | "drop" | "changes";
  };
  /** The failed nodes' errors and AI summaries, by node id (task id, or `@gate`, `@reviewer`, ...). */
  failures: Record<string, { error: string; summary: RunEventMap["failure:info"]["summary"] }>;
}

export interface RunStoreOptions {
  /** Ids of the task nodes, in display order. */
  taskIds: readonly string[];
  /** Tasks already merged before this run (a resume). */
  merged?: readonly string[];
  /** Attempt budget per task (`config.attempts`). */
  attempts: number;
}

/**
 * Event-sourced view model of a run for the terminal UI: folds the runner events into per-node states and the phase.
 * Every change produces a new `ViewState` object, so it can back `useSyncExternalStore`.
 */
export class RunStore {
  private state: ViewState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(events: RunEmitter, opts: RunStoreOptions) {
    const merged = new Set(opts.merged);
    this.state = {
      nodes: Object.fromEntries(
        opts.taskIds.map((id) => [
          id,
          { status: merged.has(id) ? "merged" : "pending", attempt: 0, attempts: opts.attempts, label: id },
        ]),
      ),
      agents: {
        reviewer: { status: "pending", attempt: 0, attempts: opts.attempts, label: "reviewer" },
        tester: { status: "pending", attempt: 0, attempts: opts.attempts, label: "tester" },
        fixer: { status: "pending", attempt: 0, attempts: opts.attempts, label: "fixer" },
        gateFixer: { status: "pending", attempt: 0, attempts: opts.attempts, label: "validation fixer" },
      },
      gate: { status: "pending", attempt: 0, attempts: 1, label: "validate" },
      merge: { status: "pending", attempt: 0, attempts: 1, label: "merge" },
      phase: { phase: "tasks" },
      events: [],
      retryable: [],
      mergeable: false,
      failures: {},
    };
    this.unsubscribe = [
      events.on("task:start", ({ taskId }) =>
        this.setNode(taskId, { status: "running", attempt: 1, round: undefined, rounds: undefined }),
      ),
      events.on("nodeChanges", ({ nodeId, changes }) => {
        if (nodeId in this.state.nodes) this.setNode(nodeId, { changes });
        else {
          const agent = REVIEW_AGENTS.find((a) => AGENT_NODE[a] === nodeId);
          if (agent) this.setAgent(agent, { changes });
        }
      }),
      events.on("review:end", ({ round, reports }) => {
        const cases = reports.find((r) => r.reviewer === "tester")?.cases;
        if (reports.some((r) => r.reviewer === "tester"))
          this.setAgent("tester", { testPlan: cases ? { round, cases } : undefined });
      }),
      events.on("task:retry", ({ taskId, attempt, attempts }) => this.setNode(taskId, { status: "running", attempt, attempts })),
      events.on("task:status", ({ taskId, status, round, rounds }) => this.setNode(taskId, { status, round, rounds })),
      events.on("task:merged", ({ taskId }) => this.setNode(taskId, { status: "merged" })),
      events.on("task:failed", ({ taskId }) => this.setNode(taskId, { status: "failed" })),
      events.on("phase:change", (phase) => {
        const gate = this.state.gate.status;
        if (phase.phase === "validate") this.patch({ phase, gate: stamped(this.state.gate, { status: "running" }) });
        else if (phase.phase !== "tasks" && (gate === "pending" || gate === "running")) {
          this.patch({ phase, gate: stamped(this.state.gate, { status: "done" }) });
        } else this.patch({ phase });
      }),
      events.on("merge:status", ({ status }) => this.patch({ merge: { ...this.state.merge, status } })),
      events.on("agent:start", ({ agent, label }) =>
        this.setAgent(agent, { status: "running", attempt: 1, label, round: undefined, rounds: undefined }),
      ),
      events.on("agent:retry", ({ agent, label, attempt, attempts }) =>
        this.setAgent(agent, { status: "running", attempt, attempts, label }),
      ),
      events.on("agent:status", ({ agent, status, round, rounds, label }) =>
        this.setAgent(agent, { status, round, rounds, ...(label ? { label } : {}) }),
      ),
      events.on("agent:end", ({ agent, label, ok }) => this.setAgent(agent, { status: ok ? "done" : "failed", label })),
      events.on("retry:available", ({ nodes, merge }) => this.patch({ retryable: [...nodes], mergeable: merge === true })),
      events.on("review:waiting", ({ round, reviewRound, blocking }) => {
        this.reviewFindings = blocking;
        this.patch({ review: { waiting: true, round, ...(reviewRound !== undefined ? { reviewRound } : {}), blocking } });
      }),
      events.on("review:decided", ({ decision }) =>
        this.patch({ review: this.state.review ? { ...this.state.review, waiting: false, decision } : undefined }),
      ),
      events.on("failure:info", ({ nodeId, error, summary }) =>
        this.patch({ failures: { ...this.state.failures, [nodeId]: { error, summary } } }),
      ),
      events.on("run:restart", () => {
        // Everything that did not finish goes back to pending: the retried node, killed siblings, settled steps.
        const reset = (node: NodeView): NodeView =>
          node.status === "merged" || node.status === "done"
            ? node
            : stamped(node, { status: "pending", attempt: 0, round: undefined, rounds: undefined });
        const { agents } = this.state;
        this.patch({
          summary: undefined,
          retryable: [],
          mergeable: false,
          failures: {},
          nodes: Object.fromEntries(Object.entries(this.state.nodes).map(([id, node]) => [id, reset(node)])),
          agents: {
            reviewer: reset(agents.reviewer),
            tester: reset(agents.tester),
            fixer: reset(agents.fixer),
            gateFixer: reset(agents.gateFixer),
          },
          gate: reset(this.state.gate),
          merge: reset(this.state.merge),
        });
      }),
      events.on("run:end", (summary) => {
        // Whatever was still waiting or in progress did not happen: an abort fails the running step.
        const settle = (node: NodeView): NodeView =>
          node.status === "pending"
            ? stamped(node, { status: "skipped" })
            : node.status === "running" ||
                node.status === "validating" ||
                node.status === "fixing" ||
                node.status === "merging"
              ? stamped(node, { status: "failed" })
              : node;
        const agents = {
          ...this.state.agents,
          fixer: settle(this.state.agents.fixer),
          gateFixer: settle(this.state.agents.gateFixer),
        };
        this.patch({ summary, agents, gate: settle(this.state.gate), merge: settle(this.state.merge) });
      }),
    ];
  }

  getState = (): ViewState => this.state;

  /** Adds a line of the run's own log to the events panel; a multi-line entry keeps its first line. */
  addEvent(text: string, now = new Date()): void {
    const first = text.split("\n").find((l) => l.trim() !== "");
    if (first === undefined) return;
    const lines = text.trim().split("\n").length;
    const event = { time: now.toTimeString().slice(0, 8), text: lines > 1 ? `${first.trimEnd()} …` : first.trimEnd() };
    this.patch({ events: [...this.state.events, event].slice(-EVENTS_KEPT) });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.listeners.clear();
  }

  private setNode(id: string, change: Partial<NodeView>): void {
    const node = this.state.nodes[id] ?? { status: "pending", attempt: 0, attempts: 1, label: id };
    this.patch({ nodes: { ...this.state.nodes, [id]: stamped(node, change) } });
  }

  private setAgent(agent: ReviewAgent, change: Partial<NodeView>): void {
    this.patch({ agents: { ...this.state.agents, [agent]: stamped(this.state.agents[agent], change) } });
  }

  /** Drops findings whose ids are in `resolved` from the pause's open findings (all of them come back when nothing is resolved). */
  setReviewResolved(resolved: ReadonlySet<string>, comments?: { total: number; open: number; addressed: number }): void {
    const review = this.state.review;
    if (!review?.waiting) return;
    const all = this.reviewFindings;
    this.patch({ review: { ...review, blocking: all.filter((f) => !resolved.has(f.id)), ...(comments ? { comments } : {}) } });
  }

  private reviewFindings: Finding[] = [];

  private patch(change: Partial<ViewState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

/** Ids of the failed nodes: tasks first in key order, then the gate, the review agents and the apply step. */
export function failedNodeIds(state: ViewState): string[] {
  const tasks = Object.keys(state.nodes).filter((id) => state.nodes[id]!.status === "failed");
  const pipeline: [string, NodeView][] = [
    [GATE_NODE, state.gate],
    [AGENT_NODE.gateFixer, state.agents.gateFixer],
    [AGENT_NODE.reviewer, state.agents.reviewer],
    [AGENT_NODE.tester, state.agents.tester],
    [AGENT_NODE.fixer, state.agents.fixer],
    [MERGE_NODE, state.merge],
  ];
  return [...tasks, ...pipeline.filter(([, node]) => node.status === "failed").map(([id]) => id)];
}

/** File name for an agent label: anything but letters, digits, `.`, `_` and `-` becomes `-`. */
export const logFileName = (label: string): string => `${label.replace(/[^\w.-]+/g, "-")}.log`;

/**
 * Appends every agent's output to `<logsDir>/<label>.log` (PRD §7.9: full output is always kept, whatever the UI
 * shows). Returns a function that stops writing.
 */
export function writeAgentLogs(events: RunEmitter, logsDir: string): () => void {
  mkdirSync(logsDir, { recursive: true });
  return events.on("output", ({ label, text }) => {
    appendFileSync(path.join(logsDir, logFileName(label)), text.endsWith("\n") ? text : `${text}\n`);
  });
}
