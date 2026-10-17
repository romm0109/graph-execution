import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PhaseChange, ReviewAgent, RunEmitter, RunEnd } from "../runner/events.js";

/** `done` is a review-phase agent's success, `merged` a task's. */
export type NodeStatus = "pending" | "running" | "validating" | "merging" | "merged" | "done" | "failed";

export interface NodeView {
  status: NodeStatus;
  /** The current attempt, 0 before the task starts. */
  attempt: number;
  /** The attempt budget, for `retry N/M`. */
  attempts: number;
  /** The agent label whose output belongs to this node: the task id, or the review agent's current run (`code-r1`). */
  label: string;
}

/** The review-phase nodes under the task graph, in display order. */
export const REVIEW_AGENTS: readonly ReviewAgent[] = ["reviewer", "tester", "fixer"];

export interface ViewState {
  /** Task nodes by task id. */
  nodes: Record<string, NodeView>;
  /** The code reviewer, live tester and fixer nodes. */
  agents: Record<ReviewAgent, NodeView>;
  phase: PhaseChange;
  /** Set once the run is over: the final summary replaces the live tail. */
  summary?: RunEnd;
  /** The agent label whose output the log tail shows. */
  focus: string | undefined;
  /** The last `tailSize` output lines per agent label. */
  tails: Record<string, readonly string[]>;
}

export const TAIL_SIZE = 200;

export interface RunStoreOptions {
  /** Ids of the task nodes, in display order. */
  taskIds: readonly string[];
  /** Tasks already merged before this run (a resume). */
  merged?: readonly string[];
  /** Attempt budget per task (`config.attempts`). */
  attempts: number;
  tailSize?: number;
}

/** Splits an output chunk into lines, without the empty line after a trailing newline. */
const toLines = (text: string): string[] => text.replace(/\r?\n$/, "").split(/\r?\n/);

/**
 * Event-sourced view model of a run for the terminal UI: folds the runner events into per-node states, the phase and
 * a ring buffer of the latest output lines per agent. Every change produces a new `ViewState` object, so it can back
 * `useSyncExternalStore`.
 */
export class RunStore {
  private state: ViewState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];
  private readonly tailSize: number;
  /** Set once the user moved the focus; until then it follows the latest started task. */
  private pinned = false;

  constructor(events: RunEmitter, opts: RunStoreOptions) {
    this.tailSize = opts.tailSize ?? TAIL_SIZE;
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
      phase: { phase: "tasks" },
      focus: undefined,
      tails: {},
    };
    this.unsubscribe = [
      events.on("task:start", ({ taskId }) => {
        this.setNode(taskId, { status: "running", attempt: 1 });
        if (!this.pinned) this.patch({ focus: taskId });
      }),
      events.on("task:retry", ({ taskId, attempt, attempts }) => this.setNode(taskId, { status: "running", attempt, attempts })),
      events.on("task:status", ({ taskId, status }) => this.setNode(taskId, { status })),
      events.on("task:merged", ({ taskId }) => this.setNode(taskId, { status: "merged" })),
      events.on("task:failed", ({ taskId }) => this.setNode(taskId, { status: "failed" })),
      events.on("phase:change", (phase) => this.patch({ phase })),
      events.on("agent:start", ({ agent, label }) => {
        this.setAgent(agent, { status: "running", attempt: 1, label });
        if (!this.pinned) this.patch({ focus: label });
      }),
      events.on("agent:retry", ({ agent, label, attempt, attempts }) =>
        this.setAgent(agent, { status: "running", attempt, attempts, label }),
      ),
      events.on("agent:status", ({ agent, status }) => this.setAgent(agent, { status })),
      events.on("agent:end", ({ agent, label, ok }) => this.setAgent(agent, { status: ok ? "done" : "failed", label })),
      events.on("run:end", (summary) => this.patch({ summary })),
      events.on("output", ({ label, text }) => {
        const tail = [...(this.state.tails[label] ?? []), ...toLines(text)].slice(-this.tailSize);
        this.patch({ tails: { ...this.state.tails, [label]: tail }, focus: this.state.focus ?? label });
      }),
    ];
  }

  getState = (): ViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Labels the focus can move between: started tasks in display order, the started review agents, then other agents
   * that produced output (earlier review rounds, resolvers).
   */
  focusable(): string[] {
    const nodes = [...Object.values(this.state.nodes), ...REVIEW_AGENTS.map((a) => this.state.agents[a])];
    const started = nodes.filter((n) => n.status !== "pending" || this.state.tails[n.label]).map((n) => n.label);
    const others = Object.keys(this.state.tails).filter((label) => !started.includes(label));
    return [...started, ...others];
  }

  /** Moves the focus `delta` steps through `focusable()`, wrapping around. */
  moveFocus(delta: number): void {
    const labels = this.focusable();
    if (labels.length === 0) return;
    const current = this.state.focus === undefined ? -1 : labels.indexOf(this.state.focus);
    const next = (((current + delta) % labels.length) + labels.length) % labels.length;
    this.pinned = true;
    this.patch({ focus: labels[next] });
  }

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
