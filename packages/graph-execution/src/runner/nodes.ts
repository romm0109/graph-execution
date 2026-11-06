import type { ReviewAgent } from "./events.js";

/** Ids of the pipeline nodes after the task graph; `@` cannot start a task id that reads well, and never collides. */
export const GATE_NODE = "@gate";
export const MERGE_NODE = "@merge";
export const AGENT_NODE: Record<ReviewAgent, string> = {
  reviewer: "@reviewer",
  tester: "@tester",
  fixer: "@fixer",
  gateFixer: "@gate-fixer",
};
export const isPipelineNode = (id: string): boolean => id.startsWith("@");
