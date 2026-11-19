export type AgentRole = "task" | "resolver" | "reviewer" | "tester" | "fixer" | "summarizer" | "planner" | "advisor";

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
  /** Where the agent may write an escalation; real providers ignore it, the path is in the prompt. */
  escalationFile?: string;
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

/** What `Provider.interactive` is asked for: an interactive session in `cwd` that starts with `firstMessage`. */
export interface InteractiveOptions {
  cwd: string;
  firstMessage: string;
  model?: string;
}

/** The command line of a provider's interactive CLI, run in a PTY (the escalation advisor, src/agents/advisor.ts). */
export interface InteractiveCommand {
  file: string;
  args: string[];
  /** Added to the PTY's environment. */
  env?: Record<string, string>;
  /** The CLI takes no first message on its command line: it is typed into the PTY (followed by Enter) after start. */
  typeFirstMessage?: boolean;
}

export interface Provider {
  name: string;
  run(opts: AgentRunOptions): AgentRun;
  /** The provider's interactive CLI; a provider without one has no advisor terminal. Optional so test doubles need not have it. */
  interactive?(opts: InteractiveOptions): InteractiveCommand;
}
