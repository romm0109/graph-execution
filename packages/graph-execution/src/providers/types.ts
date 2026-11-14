export type AgentRole = "task" | "resolver" | "reviewer" | "tester" | "fixer" | "summarizer" | "planner";

export interface AgentRunOptions {
  role: AgentRole;
  prompt: string;
  /** The agent's working directory: always its own worktree. */
  cwd: string;
  signal: AbortSignal;
  model?: string;
  /** Identifies the agent instance; for task agents this is the task id. */
  label: string;
  /** Told about every OS process the run starts (`trackProcesses`, src/state/processes.ts). */
  processHooks?: ProcessHooks;
}

/** Told about every OS process an agent run starts, so a killed CLI's agents can be found later (`src/state/processes.ts`). */
export interface ProcessHooks {
  started(pid: number, command: string): void;
  exited(pid: number): void;
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
