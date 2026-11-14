import type { PipelineAgent } from "./events.js";

/** Ids of the pipeline nodes after the task graph; `@` cannot start a task id that reads well, and never collides. */
export const GATE_NODE = "@gate";
export const MERGE_NODE = "@merge";
export const AGENT_NODE: Record<PipelineAgent, string> = {
  reviewer: "@reviewer",
  tester: "@tester",
  fixer: "@fixer",
  gateFixer: "@gate-fixer",
};
/** The node id of an agent: its pipeline node, else `@<agent>` (a reviewer from the reviewers file). */
export const agentNode = (agent: string): string => (AGENT_NODE as Record<string, string>)[agent] ?? `@${agent}`;
export const isPipelineNode = (id: string): boolean => id.startsWith("@");
