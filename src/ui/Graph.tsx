import type React from "react";
import { Box, Text } from "ink";
import type { ReviewAgent } from "../runner/events.js";
import { glyph, type Layout, layoutGraph } from "./layout.js";
import type { NodeStatus, NodeView, ViewState } from "./store.js";
import { ACTIVE, STATUS_COLOR, statusIcon, THEME } from "./theme.js";

export { STATUS_COLOR };

/** The node's state text: `retry N/M` replaces `running` from the second attempt on. */
export function statusText(node: NodeView): string {
  if (node.status === "running" && node.attempt > 1) return `retry ${node.attempt}/${node.attempts}`;
  return node.status;
}

export const AGENT_TITLE: Record<ReviewAgent, string> = { reviewer: "code reviewer", tester: "live tester", fixer: "fixer" };

/** Ids of the pipeline nodes after the task graph; `@` cannot start a task id that reads well, and never collides. */
const GATE = "@gate";
const MERGE = "@merge";
const AGENT_ID: Record<ReviewAgent, string> = { reviewer: "@reviewer", tester: "@tester", fixer: "@fixer" };

export interface GraphProps {
  /** Task ids per execution layer. */
  layers: readonly (readonly string[])[];
  /** Dependencies per task id. */
  parents: Readonly<Record<string, readonly string[]>>;
  state: Pick<ViewState, "nodes" | "agents" | "gate" | "merge">;
  /** The branch the result is merged into at the end; shown on the last node. */
  mergeTarget?: string;
  /** Spinner frame. */
  frame: number;
  /** Terminal width: the layout shrinks, then falls back to one line per layer, to fit. */
  columns: number;
}

interface Cell {
  ch: string;
  color?: string;
  bold?: boolean;
}

interface GraphNode {
  title: string;
  view: NodeView;
}

/**
 * The run as one top-down graph (PRD §7.9): the task DAG with arrows from each task to its dependents, then the
 * pipeline every run goes through once the tasks are merged: validation gate → code reviewer and live tester →
 * fixer → merge into the starting branch.
 */
export function Graph(props: GraphProps) {
  return renderGraph(props).element;
}

/** The graph's element and its height in lines (margins included), so the caller can fit the rest of the screen. */
export function renderGraph({ layers, parents, state, mergeTarget, frame, columns }: GraphProps): {
  element: React.JSX.Element;
  height: number;
} {
  const nodes = new Map<string, GraphNode>();
  for (const layer of layers) for (const id of layer) if (state.nodes[id]) nodes.set(id, { title: id, view: state.nodes[id]! });
  nodes.set(GATE, { title: "validate", view: state.gate });
  for (const agent of ["reviewer", "tester", "fixer"] as const) {
    nodes.set(AGENT_ID[agent], { title: AGENT_TITLE[agent], view: state.agents[agent] });
  }
  nodes.set(MERGE, { title: mergeTarget ? `apply → ${mergeTarget}` : "result branch", view: state.merge });

  // The pipeline hangs below the tasks nobody depends on.
  const hasChildren = new Set(Object.values(parents).flat());
  const sinks = layers.flat().filter((id) => !hasChildren.has(id));
  const allLayers = [...layers, [GATE], [AGENT_ID.reviewer, AGENT_ID.tester], [AGENT_ID.fixer], [MERGE]];
  const allParents: Record<string, readonly string[]> = {
    ...parents,
    [GATE]: sinks,
    [AGENT_ID.reviewer]: [GATE],
    [AGENT_ID.tester]: [GATE],
    [AGENT_ID.fixer]: [AGENT_ID.reviewer, AGENT_ID.tester],
    [MERGE]: [AGENT_ID.fixer],
  };

  const longest = Math.max(...[...nodes.values()].map((n) => n.title.length));
  for (const [nodeWidth, gap] of [
    [Math.min(28, Math.max(18, longest + 6)), 3],
    [16, 2],
    [13, 1],
  ] as const) {
    const layout = layoutGraph({ layers: allLayers, parents: allParents, nodeWidth, nodeHeight: 3, gap });
    if (layout.width <= columns) {
      return { element: <Canvas rows={paint(layout, nodes, nodeWidth, frame)} />, height: layout.height + 2 };
    }
  }
  return {
    element: <CompactGraph layers={allLayers} nodes={nodes} frame={frame} />,
    height: allLayers.length * 2 + 1,
  };
}

const edgeColor = (status: NodeStatus): string =>
  status === "merged" || status === "done" ? THEME.ok : status === "pending" || status === "skipped" ? THEME.faint : STATUS_COLOR[status];

/** Paints the edges, then the node boxes over them. */
function paint(layout: Layout, nodes: Map<string, GraphNode>, width: number, frame: number): Cell[][] {
  const grid: Cell[][] = Array.from({ length: layout.height }, () => Array.from({ length: layout.width }, () => ({ ch: " " })));
  for (const s of layout.strokes) {
    const from = nodes.get(s.from);
    const cell = grid[s.y]?.[s.x];
    if (cell) Object.assign(cell, { ch: glyph(s), color: from ? edgeColor(from.view.status) : THEME.faint });
  }
  for (const placed of layout.nodes) {
    const node = nodes.get(placed.id)!;
    // Working nodes stand out with a heavy border.
    const active = ACTIVE.has(node.view.status);
    const color = STATUS_COLOR[node.view.status];
    const [h, v, tl, tr, bl, br, tee] = active ? ["━", "┃", "┏", "┓", "┗", "┛", "┳"] : ["─", "│", "╭", "╮", "╰", "╯", "┬"];
    const put = (dx: number, dy: number, ch: string, style: Omit<Cell, "ch"> = { color }): void => {
      const cell = grid[placed.y + dy]?.[placed.x + dx];
      if (cell) Object.assign(cell, { ch, ...style });
    };
    const inner = width - 2;
    const title = ` ${truncate(node.title, inner - 3)} `;
    const status = `${statusIcon(node.view.status, frame)} ${statusText(node.view)}`;
    for (let dx = 0; dx < width; dx++) {
      put(dx, 0, dx === 0 ? tl : dx === width - 1 ? tr : h);
      put(dx, 2, dx === 0 ? bl : dx === width - 1 ? br : placed.hasChildren && dx === Math.floor(width / 2) ? tee : h);
      put(dx, 1, dx === 0 || dx === width - 1 ? v : " ");
    }
    [...title].forEach((ch, i) => put(2 + i, 0, ch, { color: active ? THEME.accent : THEME.text, bold: true }));
    [...truncate(status, inner - 2)].forEach((ch, i) => put(2 + i, 1, ch, { color, bold: active }));
  }
  return grid;
}

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`);

/** Renders a cell grid as one `Text` per row, with a nested `Text` per run of equally styled cells. */
function Canvas({ rows }: { rows: Cell[][] }) {
  return (
    <Box flexDirection="column" marginY={1}>
      {rows.map((row, y) => {
        const runs: Cell[] = [];
        for (const cell of row) {
          const last = runs.at(-1);
          if (last && last.color === cell.color && last.bold === cell.bold) last.ch += cell.ch;
          else runs.push({ ...cell });
        }
        return (
          <Text key={y} wrap="truncate-end">
            {runs.map((r, i) => (
              <Text key={i} color={r.color} bold={r.bold}>
                {r.ch}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}

/** Too narrow a terminal for boxes: one line of nodes per layer, a down arrow between layers. */
function CompactGraph({
  layers,
  nodes,
  frame,
}: {
  layers: readonly (readonly string[])[];
  nodes: Map<string, GraphNode>;
  frame: number;
}) {
  return (
    <Box flexDirection="column" marginY={1}>
      {layers.map((layer, i) => (
        <Box key={i} flexDirection="column">
          {i > 0 ? <Text color={THEME.faint}> ▼</Text> : null}
          <Text wrap="wrap">
            {layer.map((id, j) => {
              const node = nodes.get(id)!;
              const color = STATUS_COLOR[node.view.status];
              return (
                <Text key={id}>
                  {j > 0 ? "  " : ""}
                  <Text color={color} bold={ACTIVE.has(node.view.status)}>
                    {`${statusIcon(node.view.status, frame)} ${node.title} ${statusText(node.view)}`}
                  </Text>
                </Text>
              );
            })}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
