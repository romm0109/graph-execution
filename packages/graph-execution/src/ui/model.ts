import type { ReviewAgent } from "../runner/events.js";
import { AGENT_NODE, GATE_NODE, MERGE_NODE } from "../runner/nodes.js";
import type { NodeView, ViewState } from "./store.js";

export const AGENT_TITLE: Record<ReviewAgent, string> = {
  reviewer: "code reviewer",
  tester: "live tester",
  fixer: "fixer",
  gateFixer: "validation fixer",
};

export interface GraphNode {
  title: string;
  view: NodeView;
}

export interface GraphModel {
  nodes: Map<string, GraphNode>;
  layers: string[][];
  parents: Record<string, readonly string[]>;
}

export interface GraphModelInput {
  /** Task ids per execution layer. */
  layers: readonly (readonly string[])[];
  /** Dependencies per task id. */
  parents: Readonly<Record<string, readonly string[]>>;
  state: Pick<ViewState, "nodes" | "agents" | "gate" | "merge">;
  mergeTarget?: string;
}

/**
 * The whole run as a graph: the task DAG, then the pipeline every run goes through once the tasks are merged:
 * validation gate → code reviewer and live tester → fixer → apply. A validation fixer shows between the gate and the
 * reviewers once the gate has failed.
 */
export function graphModel({ layers, parents, state, mergeTarget }: GraphModelInput): GraphModel {
  const nodes = new Map<string, GraphNode>();
  for (const layer of layers) for (const id of layer) if (state.nodes[id]) nodes.set(id, { title: id, view: state.nodes[id]! });
  nodes.set(GATE_NODE, { title: "validate", view: state.gate });
  // The validation fixer only shows once the gate has failed and sent it work.
  const gateFixed = state.agents.gateFixer.status !== "pending" && state.agents.gateFixer.status !== "skipped";
  for (const agent of ["reviewer", "tester", "fixer", ...(gateFixed ? (["gateFixer"] as const) : [])] as const) {
    nodes.set(AGENT_NODE[agent], { title: AGENT_TITLE[agent], view: state.agents[agent] });
  }
  nodes.set(MERGE_NODE, { title: mergeTarget ? `apply → ${mergeTarget}` : "result branch", view: state.merge });

  // The pipeline hangs below the tasks nobody depends on.
  const hasChildren = new Set(Object.values(parents).flat());
  const sinks = layers.flat().filter((id) => !hasChildren.has(id));
  const beforeReview = gateFixed ? AGENT_NODE.gateFixer : GATE_NODE;
  return {
    nodes,
    layers: [
      ...layers.map((l) => [...l]),
      [GATE_NODE],
      ...(gateFixed ? [[AGENT_NODE.gateFixer]] : []),
      [AGENT_NODE.reviewer, AGENT_NODE.tester],
      [AGENT_NODE.fixer],
      [MERGE_NODE],
    ],
    parents: {
      ...parents,
      [GATE_NODE]: sinks,
      [AGENT_NODE.gateFixer]: [GATE_NODE],
      [AGENT_NODE.reviewer]: [beforeReview],
      [AGENT_NODE.tester]: [beforeReview],
      [AGENT_NODE.fixer]: [AGENT_NODE.reviewer, AGENT_NODE.tester],
      [MERGE_NODE]: [AGENT_NODE.fixer],
    },
  };
}
