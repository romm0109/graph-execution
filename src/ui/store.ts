import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PhaseChange, ReviewAgent, RunEmitter, RunEnd } from "../runner/events.js";

/** `done` is a review-phase agent's success, `merged` a task's; `skipped` a pipeline step that was not needed. */
export type NodeStatus = "pending" | "running" | "validating" | "merging" | "merged" | "done" | "failed" | "skipped";

export interface NodeView {
  status: NodeStatus;
  /** The current attempt, 0 before the task starts. */
  attempt: number;
  /** The attempt budget, for `retry N/M`. */
  attempts: number;
  /** The agent label of this node: the task id, or the review agent's current run (`code-r1`). */
  label: string;
}

/** The review-phase nodes under the task graph, in display order. */
export const REVIEW_AGENTS: readonly ReviewAgent[] = ["reviewer", "tester", "fixer"];

export interface ViewState {
  /** Task nodes by task id. */
  nodes: Record<string, NodeView>;
  /** The code reviewer, live tester and fixer nodes. */
  agents: Record<ReviewAgent, NodeView>;
  /** The validation gate before the first review. */
  gate: NodeView;
  /** The final merge into the starting branch. */
  merge: NodeView;
  phase: PhaseChange;
  /** Set once the run is over: the final summary shows under the graph. */
  summary?: RunEnd;
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
      },
      gate: { status: "pending", attempt: 0, attempts: 1, label: "validate" },
      merge: { status: "pending", attempt: 0, attempts: 1, label: "merge" },
      phase: { phase: "tasks" },
    };
    this.unsubscribe = [
      events.on("task:start", ({ taskId }) => this.setNode(taskId, { status: "running", attempt: 1 })),
      events.on("task:retry", ({ taskId, attempt, attempts }) => this.setNode(taskId, { status: "running", attempt, attempts })),
      events.on("task:status", ({ taskId, status }) => this.setNode(taskId, { status })),
      events.on("task:merged", ({ taskId }) => this.setNode(taskId, { status: "merged" })),
      events.on("task:failed", ({ taskId }) => this.setNode(taskId, { status: "failed" })),
      events.on("phase:change", (phase) => {
        const gate = this.state.gate.status;
        if (phase.phase === "validate") this.patch({ phase, gate: { ...this.state.gate, status: "running" } });
        else if (phase.phase !== "tasks" && (gate === "pending" || gate === "running")) {
          this.patch({ phase, gate: { ...this.state.gate, status: "done" } });
        } else this.patch({ phase });
      }),
      events.on("merge:status", ({ status }) => this.patch({ merge: { ...this.state.merge, status } })),
      events.on("agent:start", ({ agent, label }) => this.setAgent(agent, { status: "running", attempt: 1, label })),
      events.on("agent:retry", ({ agent, label, attempt, attempts }) =>
        this.setAgent(agent, { status: "running", attempt, attempts, label }),
      ),
      events.on("agent:status", ({ agent, status }) => this.setAgent(agent, { status })),
      events.on("agent:end", ({ agent, label, ok }) => this.setAgent(agent, { status: ok ? "done" : "failed", label })),
      events.on("run:end", (summary) => {
        // Whatever was still waiting or in progress did not happen: an abort fails the running step.
        const settle = (node: NodeView): NodeView =>
          node.status === "pending"
            ? { ...node, status: "skipped" }
            : node.status === "running" || node.status === "validating" || node.status === "merging"
              ? { ...node, status: "failed" }
              : node;
        const agents = { ...this.state.agents, fixer: settle(this.state.agents.fixer) };
        this.patch({ summary, agents, gate: settle(this.state.gate), merge: settle(this.state.merge) });
      }),
    ];
  }

  getState = (): ViewState => this.state;

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
    this.patch({ nodes: { ...this.state.nodes, [id]: { ...node, ...change } } });
  }

  private setAgent(agent: ReviewAgent, change: Partial<NodeView>): void {
    this.patch({ agents: { ...this.state.agents, [agent]: { ...this.state.agents[agent], ...change } } });
  }

  private patch(change: Partial<ViewState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
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
