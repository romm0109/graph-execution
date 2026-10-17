import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ReviewAgent } from "../runner/events.js";
import type { NodeStatus, NodeView } from "./store.js";

export const STATUS_COLOR: Record<NodeStatus, string> = {
  pending: "gray",
  running: "yellow",
  validating: "cyan",
  merging: "magenta",
  merged: "green",
  done: "green",
  failed: "red",
};

const ACTIVE: ReadonlySet<NodeStatus> = new Set(["running", "validating", "merging"]);

/** The node's state text: `retry N/M` replaces `running` from the second attempt on. */
export function statusText(node: NodeView): string {
  if (node.status === "running" && node.attempt > 1) return `retry ${node.attempt}/${node.attempts}`;
  return node.status;
}

export function Node({ title, node, focused }: { title: string; node: NodeView; focused: boolean }) {
  const color = STATUS_COLOR[node.status];
  return (
    <Box borderStyle={focused ? "double" : "round"} borderColor={color} flexDirection="column" paddingX={1} minWidth={14}>
      <Text bold={focused}>{title}</Text>
      <Text color={color}>
        {ACTIVE.has(node.status) ? (
          <>
            <Spinner type="dots" />{" "}
          </>
        ) : null}
        {statusText(node)}
      </Text>
    </Box>
  );
}

/** The task DAG: one column per execution layer, one bordered box per task colored by its status. */
export function Graph({ layers, nodes, focus }: { layers: string[][]; nodes: Record<string, NodeView>; focus?: string }) {
  return (
    <Box flexDirection="row" gap={2}>
      {layers.map((layer, i) => (
        <Box key={i} flexDirection="column">
          {layer.map((id) => {
            const node = nodes[id];
            return node ? <Node key={id} title={`task ${id}`} node={node} focused={focus === node.label} /> : null;
          })}
        </Box>
      ))}
    </Box>
  );
}

export const AGENT_TITLE: Record<ReviewAgent, string> = { reviewer: "code reviewer", tester: "live tester", fixer: "fixer" };

/**
 * The review-phase nodes under the task DAG: the code reviewer and the live tester side by side, then the fixer.
 * They render and take the focus like task nodes, through the label of the agent's current run.
 */
export function ReviewNodes({ agents, focus }: { agents: Record<ReviewAgent, NodeView>; focus?: string }) {
  const node = (agent: ReviewAgent) => (
    <Node title={AGENT_TITLE[agent]} node={agents[agent]} focused={focus === agents[agent].label} />
  );
  return (
    <Box flexDirection="row" gap={2} alignItems="center">
      <Box flexDirection="column">
        {node("reviewer")}
        {node("tester")}
      </Box>
      <Text dimColor>→</Text>
      {node("fixer")}
    </Box>
  );
}
