export type AgentRole = "task" | "resolver" | "reviewer" | "tester" | "fixer" | "summarizer";

export interface AgentRunOptions {
  role: AgentRole;
  prompt: string;
  /** The agent's working directory: always its own worktree. */
  cwd: string;
  signal: AbortSignal;
  model?: string;
  /** Identifies the agent instance; for task agents this is the task id. */
  label: string;
}

export type AgentEvent = { type: "output"; text: string } | { type: "exit"; code: number };

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  done: Promise<{ exitCode: number }>;
}

export interface Provider {
  name: string;
  run(opts: AgentRunOptions): AgentRun;
}
