// The layered task graph of a run (boards 12, 13): a column per dependency layer, a card per task,
// and an SVG cubic curve per dependency. Reused by the Terminals run pane (`compact`).

import { toneOf, glyphOf } from "../ui/status";
import type { RunGraph, TaskRow } from "../runs";
import "./TaskGraph.css";

interface Metrics {
  nodeW: number;
  nodeH: number;
  colGap: number;
  rowGap: number;
  padX: number;
  top: number;
  bottom: number;
  bend: number;
}

const FULL: Metrics = { nodeW: 200, nodeH: 64, colGap: 60, rowGap: 24, padX: 16, top: 30, bottom: 16, bend: 34 };
const COMPACT: Metrics = { nodeW: 160, nodeH: 52, colGap: 40, rowGap: 14, padX: 12, top: 26, bottom: 12, bend: 24 };

export interface TaskGraphProps {
  graph: RunGraph;
  /** Rows of the task table; their status wins over the graph's. */
  tasks?: TaskRow[];
  compact?: boolean;
  onSelect?: (id: string) => void;
  /** The node to outline, e.g. the one selected. */
  selected?: string;
}

/** Node positions by id, and the drawing's size. */
export function layoutGraph(graph: RunGraph, m: Metrics = FULL): { pos: Map<string, { x: number; y: number }>; width: number; height: number } {
  const pos = new Map<string, { x: number; y: number }>();
  graph.layers.forEach((layer, col) =>
    layer.forEach((id, row) => pos.set(id, { x: m.padX + col * (m.nodeW + m.colGap), y: m.top + row * (m.nodeH + m.rowGap) })),
  );
  const cols = Math.max(1, graph.layers.length);
  const rows = Math.max(1, ...graph.layers.map((l) => l.length));
  return {
    pos,
    width: m.padX * 2 + cols * (m.nodeW + m.colGap) - m.colGap,
    height: m.top + rows * (m.nodeH + m.rowGap) - m.rowGap + m.bottom,
  };
}

export function TaskGraph({ graph, tasks, compact = false, onSelect, selected }: TaskGraphProps) {
  const m = compact ? COMPACT : FULL;
  const { pos, width, height } = layoutGraph(graph, m);
  const rowStatus = new Map(tasks?.map((t) => [t.id, t.status]));
  const statusOf = (id: string, fallback: string): string => rowStatus.get(id) ?? fallback;
  const nodeStatus = new Map(graph.nodes.map((n) => [n.id, statusOf(n.id, n.status)]));

  return (
    <div className={`task-graph-scroll${compact ? " compact" : ""}`} data-testid="task-graph">
      <div className="task-graph" style={{ width, height }}>
        <svg className="task-graph-edges" width={width} height={height} aria-hidden="true">
          {graph.edges.map(([from, to]) => {
            const a = pos.get(from);
            const b = pos.get(to);
            if (!a || !b) return null;
            const x1 = a.x + m.nodeW;
            const y1 = a.y + m.nodeH / 2;
            const x2 = b.x;
            const y2 = b.y + m.nodeH / 2;
            const failed = nodeStatus.get(from) === "failed";
            return (
              <path
                key={`${from}->${to}`}
                className={`graph-edge${failed ? " graph-edge-bad" : ""}`}
                data-from={from}
                data-to={to}
                d={`M${x1} ${y1} C${x1 + m.bend} ${y1}, ${x2 - m.bend} ${y2}, ${x2} ${y2}`}
              />
            );
          })}
        </svg>
        {graph.layers.map((_, col) => (
          <span key={col} className="task-graph-layer" style={{ left: m.padX + col * (m.nodeW + m.colGap) }}>
            LAYER {col}
          </span>
        ))}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const status = nodeStatus.get(n.id) ?? n.status;
          const tone = toneOf("task", status);
          const glyph = glyphOf("task", status);
          return (
            <button
              type="button"
              key={n.id}
              className={`graph-node status-${status} tone-${tone}${selected === n.id ? " selected" : ""}`}
              data-testid={`graph-node-${n.id}`}
              data-layer={graph.layers.findIndex((l) => l.includes(n.id))}
              style={{ left: p.x, top: p.y, width: m.nodeW, height: m.nodeH }}
              title={`${n.title} (${n.id}): ${status}`}
              onClick={() => onSelect?.(n.id)}
            >
              <span className="graph-node-title">
                <span className={`glyph glyph-${glyph} tone-${tone}`} aria-hidden="true" />
                <span className="graph-node-name">{n.title}</span>
              </span>
              <span className="graph-node-sub">
                <span>{n.id}</span>
                <span className={`graph-node-status tone-${tone}`}>{status}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
