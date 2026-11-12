import type { PipelineAgent } from "../runner/events.js";
import { AGENT_NODE, GATE_NODE, MERGE_NODE } from "../runner/nodes.js";
import { agentView, type NodeView, type ViewState } from "./store.js";

export const AGENT_TITLE: Record<PipelineAgent, string> = {
  reviewer: "code reviewer",
  tester: "live tester",
  fixer: "fixer",
  gateFixer: "validation fixer",
};

export interface GraphNode {
  title: string;
  view: NodeView;
  /** A reviewer's provider and model, when they differ from the run's. */
  provider?: string;
  model?: string;
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
  state: Pick<ViewState, "nodes" | "agents" | "gate" | "merge" | "reviewers">;
  mergeTarget?: string;
}

/**
 * The whole run as a graph: the task DAG, then the pipeline every run goes through once the tasks are merged:
 * validation gate → the enabled reviewers (code reviewer and live tester by default) → fixer → apply. A validation fixer shows between the gate and the
 * reviewers once the gate has failed.
 */
export function graphModel({ layers, parents, state, mergeTarget }: GraphModelInput): GraphModel {
  const nodes = new Map<string, GraphNode>();
  for (const layer of layers) for (const id of layer) if (state.nodes[id]) nodes.set(id, { title: id, view: state.nodes[id]! });
  nodes.set(GATE_NODE, { title: "validate", view: state.gate });
  // The validation fixer only shows once the gate has failed and sent it work.
  const gateFixed = state.agents.gateFixer.status !== "pending" && state.agents.gateFixer.status !== "skipped";
  const reviewers = state.reviewers.flatMap((r) => {
    const view = agentView(state, r.agent);
    return view ? [{ ...r, view }] : [];
  });
  for (const r of reviewers) {
    nodes.set(r.node, { title: r.title, view: r.view, ...(r.provider ? { provider: r.provider } : {}), ...(r.model ? { model: r.model } : {}) });
  }
  for (const agent of ["fixer", ...(gateFixed ? (["gateFixer"] as const) : [])] as const) {
    nodes.set(AGENT_NODE[agent], { title: AGENT_TITLE[agent], view: state.agents[agent] });
  }
  nodes.set(MERGE_NODE, { title: mergeTarget ? `apply → ${mergeTarget}` : "result branch", view: state.merge });

  // The pipeline hangs below the tasks nobody depends on.
  const hasChildren = new Set(Object.values(parents).flat());
  const sinks = layers.flat().filter((id) => !hasChildren.has(id));
  const beforeReview = gateFixed ? AGENT_NODE.gateFixer : GATE_NODE;
  const reviewerNodes = reviewers.map((r) => r.node);
  return {
    nodes,
    layers: [
      ...layers.map((l) => [...l]),
      [GATE_NODE],
      ...(gateFixed ? [[AGENT_NODE.gateFixer]] : []),
      ...(reviewerNodes.length > 0 ? [reviewerNodes] : []),
      [AGENT_NODE.fixer],
      [MERGE_NODE],
    ],
    parents: {
      ...parents,
      [GATE_NODE]: sinks,
      [AGENT_NODE.gateFixer]: [GATE_NODE],
      ...Object.fromEntries(reviewerNodes.map((id) => [id, [beforeReview]])),
      [AGENT_NODE.fixer]: reviewerNodes.length > 0 ? reviewerNodes : [beforeReview],
      [MERGE_NODE]: [AGENT_NODE.fixer],
    },
  };
}
