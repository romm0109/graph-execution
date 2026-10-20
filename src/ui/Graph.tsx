import { Box, Text } from "ink";
import { AGENT_TITLE, type GraphNode, graphModel } from "./model.js";
import { glyph, type Layout, layoutGraph } from "./layout.js";
import type { NodeStatus, NodeView, ViewState } from "./store.js";
import { ACTIVE, STATUS_COLOR, statusIcon, THEME } from "./theme.js";

export { STATUS_COLOR };

/**
 * The node's state text: `retry N/M` replaces `running` from the second attempt on; a validation fix round shows as
 * `fixing N/M`, and the validation after it as `revalidate N/M`.
 */
export function statusText(node: NodeView): string {
  if (node.status === "running" && node.attempt > 1) return `retry ${node.attempt}/${node.attempts}`;
  if (node.status === "fixing" && node.round !== undefined) return `fixing ${node.round}/${node.rounds ?? "?"}`;
  if (node.status === "validating" && node.round) return `revalidate ${node.round}/${node.rounds ?? "?"}`;
  return node.status;
}

export { AGENT_TITLE };

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
  /** A node id to highlight (the failed node a retry would run). */
  selected?: string;
}

export interface Cell {
  ch: string;
  color?: string;
  bold?: boolean;
}

/** The graph as styled character rows, plus the rows where working nodes are, for a viewport to follow. */
export interface GraphRows {
  rows: Cell[][];
  /** Row indices of the nodes that are running, validating or merging, top first. */
  active: number[];
  /** The middle row of every node, by node id, for a viewport to follow a selection. */
  nodeRows: Record<string, number>;
}

/**
 * The run as one top-down graph (PRD §7.9), every row: the task DAG with arrows from each task to its dependents,
 * then the pipeline every run goes through once the tasks are merged: validation gate → code reviewer and live
 * tester → fixer → apply to the starting branch. A validation fixer shows between the gate and the reviewers once the
 * gate has failed.
 */
export function Graph(props: GraphProps) {
  return <Canvas rows={graphRows(props).rows} />;
}

/** Lays the graph out as rows of cells: boxes when they fit `columns`, one line per layer otherwise. */
export function graphRows({ layers, parents, state, mergeTarget, frame, columns, selected }: GraphProps): GraphRows {
  const { nodes, layers: allLayers, parents: allParents } = graphModel({ layers, parents, state, mergeTarget });

  const longest = Math.max(...[...nodes.values()].map((n) => n.title.length));
  for (const [nodeWidth, gap] of [
    // Wide enough for the longest state text, `⠋ revalidate 3/3`.
    [Math.min(28, Math.max(20, longest + 6)), 3],
    [16, 2],
    [13, 1],
  ] as const) {
    const layout = layoutGraph({ layers: allLayers, parents: allParents, nodeWidth, nodeHeight: 3, gap });
    if (layout.width <= columns) {
      const active = layout.nodes.filter((n) => ACTIVE.has(nodes.get(n.id)!.view.status)).map((n) => n.y + 1);
      return {
        rows: paint(layout, nodes, nodeWidth, frame, selected),
        active: [...new Set(active)].sort((a, b) => a - b),
        nodeRows: Object.fromEntries(layout.nodes.map((n) => [n.id, n.y + 1])),
      };
    }
  }
  return compactRows(allLayers, nodes, frame, columns, selected);
}

const edgeColor = (status: NodeStatus): string =>
  status === "merged" || status === "done" ? THEME.ok : status === "pending" || status === "skipped" ? THEME.faint : STATUS_COLOR[status];

/** Paints the edges, then the node boxes over them. */
function paint(layout: Layout, nodes: Map<string, GraphNode>, width: number, frame: number, selected?: string): Cell[][] {
  const grid: Cell[][] = Array.from({ length: layout.height }, () => Array.from({ length: layout.width }, () => ({ ch: " " })));
  for (const s of layout.strokes) {
    const from = nodes.get(s.from);
    const cell = grid[s.y]?.[s.x];
    if (cell) Object.assign(cell, { ch: glyph(s), color: from ? edgeColor(from.view.status) : THEME.faint });
  }
  for (const placed of layout.nodes) {
    const node = nodes.get(placed.id)!;
    // Working nodes stand out with a heavy border.
    const chosen = placed.id === selected;
    const active = ACTIVE.has(node.view.status) || chosen;
    const color = chosen ? THEME.accent2 : STATUS_COLOR[node.view.status];
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
    [...title].forEach((ch, i) => put(2 + i, 0, ch, { color: chosen ? THEME.accent2 : active ? THEME.accent : THEME.text, bold: true }));
    [...truncate(status, inner - 2)].forEach((ch, i) => put(2 + i, 1, ch, { color, bold: active }));
  }
  return grid;
}

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`);

/** Renders a cell grid as one `Text` per row, with a nested `Text` per run of equally styled cells. */
export function Canvas({ rows }: { rows: Cell[][] }) {
  return (
    <Box flexDirection="column">
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
function compactRows(
  layers: readonly (readonly string[])[],
  nodes: Map<string, GraphNode>,
  frame: number,
  columns: number,
  selected?: string,
): GraphRows {
  const rows: Cell[][] = [];
  const active: number[] = [];
  const nodeRows: Record<string, number> = {};
  layers.forEach((layer, i) => {
    if (i > 0) rows.push([...` ▼`].map((ch) => ({ ch, color: THEME.faint })));
    const row: Cell[] = [];
    for (const [j, id] of layer.entries()) {
      const node = nodes.get(id)!;
      if (j > 0) row.push({ ch: " " }, { ch: " " });
      nodeRows[id] = rows.length;
      const bold = ACTIVE.has(node.view.status);
      for (const ch of `${id === selected ? "▶ " : ""}${statusIcon(node.view.status, frame)} ${node.title} ${statusText(node.view)}`) {
        row.push({ ch, color: STATUS_COLOR[node.view.status], bold });
      }
    }
    if (layer.some((id) => ACTIVE.has(nodes.get(id)!.view.status))) active.push(rows.length);
    rows.push(row.slice(0, columns));
  });
  return { rows, active, nodeRows };
}
