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

/** One tool call the agent made, in the provider's own naming (`Bash`, `run_shell_command`, `command_execution`, …). */
export interface ToolCall {
  name: string;
  input: unknown;
}

export type AgentEvent =
  | { type: "output"; text: string }
  | ({ type: "tool" } & ToolCall)
  | { type: "exit"; code: number };

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  done: Promise<{ exitCode: number }>;
}

export interface Provider {
  name: string;
  run(opts: AgentRunOptions): AgentRun;
}
