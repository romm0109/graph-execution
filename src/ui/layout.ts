/**
 * Top-down layout of a layered DAG on a character grid, for the terminal UI: one row of nodes per layer, edges routed
 * through the gap between two rows as box-drawing lines ending in an arrow on the child.
 *
 * Edges that skip layers go through invisible waypoints in the layers in between, so every routed segment joins two
 * adjacent rows. In a gap, the segments into a node with several parents form one bundle (fan-in), the remaining
 * ones are bundled by parent (fan-out). Each bundle gets a horizontal track; bundles whose spans do not touch share
 * one, so the gap is only as tall as it needs to be.
 */

export interface LayoutInput {
  /** Node ids per layer, top first; every parent sits in an earlier layer than its children. */
  layers: readonly (readonly string[])[];
  /** Parent ids per node id. */
  parents: Readonly<Record<string, readonly string[]>>;
  nodeWidth: number;
  nodeHeight: number;
  /** Columns between two neighbors in a row. */
  gap: number;
}

export interface PlacedNode {
  id: string;
  /** Top-left corner. */
  x: number;
  y: number;
  /** True when the node has at least one child: its bottom border shows where the edges leave. */
  hasChildren: boolean;
}

/** One cell of edge drawing: the directions the line leaves the cell in, and the parent the line comes from. */
export interface Stroke {
  x: number;
  y: number;
  dirs: number;
  /** An arrow head pointing into the child below. */
  arrow?: boolean;
  /** The parent whose edge this is (for coloring); the last edge drawn wins on a shared cell. */
  from: string;
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  strokes: Stroke[];
}

export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;

const GLYPHS: Record<number, string> = {
  [UP]: "│",
  [DOWN]: "│",
  [UP | DOWN]: "│",
  [LEFT]: "─",
  [RIGHT]: "─",
  [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [DOWN | LEFT | RIGHT]: "┬",
  [UP | LEFT | RIGHT]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};

/** The box-drawing character for a cell's directions. */
export const glyph = (stroke: Pick<Stroke, "dirs" | "arrow">): string => (stroke.arrow ? "▼" : (GLYPHS[stroke.dirs] ?? " "));

interface Item {
  key: string;
  /** The node id, or undefined for a waypoint of a long edge. */
  id?: string;
  /** For a waypoint: the parent of the long edge, for coloring. */
  origin: string;
  width: number;
  x: number;
  parents: Item[];
  children: Item[];
}

const center = (item: Item): number => item.x + Math.floor(item.width / 2);

export function layoutGraph(input: LayoutInput): Layout {
  const { nodeWidth, nodeHeight, gap } = input;
  const rows: Item[][] = input.layers.map(() => []);
  const byId = new Map<string, Item>();
  const rowOf = new Map<string, number>();
  input.layers.forEach((layer, r) =>
    layer.forEach((id) => {
      const item: Item = { key: id, id, origin: id, width: nodeWidth, x: 0, parents: [], children: [] };
      rows[r]!.push(item);
      byId.set(id, item);
      rowOf.set(id, r);
    }),
  );
  const link = (parent: Item, child: Item): void => {
    parent.children.push(child);
    child.parents.push(parent);
  };
  for (const layer of input.layers) {
    for (const id of layer) {
      const child = byId.get(id)!;
      for (const p of input.parents[id] ?? []) {
        const parent = byId.get(p);
        if (!parent) continue;
        let prev = parent;
        // A waypoint in every layer the edge skips.
        for (let r = rowOf.get(p)! + 1; r < rowOf.get(id)!; r++) {
          const way: Item = { key: `${p}->${id}@${r}`, origin: p, width: 1, x: 0, parents: [], children: [] };
          rows[r]!.push(way);
          link(prev, way);
          prev = way;
        }
        link(prev, child);
      }
    }
  }

  order(rows);

  // Rows are centered on the widest one.
  const rowWidth = (row: Item[]): number => row.reduce((w, item) => w + item.width, 0) + gap * Math.max(0, row.length - 1);
  const width = Math.max(1, ...rows.map(rowWidth));
  for (const row of rows) {
    let x = Math.floor((width - rowWidth(row)) / 2);
    for (const item of row) {
      item.x = x;
      x += item.width + gap;
    }
  }

  const strokes = new Map<string, Stroke>();
  const add = (x: number, y: number, dirs: number, from: string): void => {
    const key = `${x},${y}`;
    const s = strokes.get(key);
    if (s) {
      s.dirs |= dirs;
      s.from = from;
    } else strokes.set(key, { x, y, dirs, from });
  };
  /** A vertical line from row y1 down to row y2, open at both ends so it joins whatever is there. */
  const vline = (x: number, y1: number, y2: number, from: string): void => {
    for (let y = y1; y <= y2; y++) add(x, y, (y > y1 ? UP : 0) | (y < y2 ? DOWN : 0), from);
  };
  const hline = (y: number, x1: number, x2: number, from: string): void => {
    const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let x = a; x <= b; x++) add(x, y, (x > a ? LEFT : 0) | (x < b ? RIGHT : 0), from);
  };

  const nodes: PlacedNode[] = [];
  let y = 0;
  rows.forEach((row, r) => {
    const top = y;
    const bottom = top + nodeHeight - 1;
    for (const item of row) {
      if (item.id !== undefined) nodes.push({ id: item.id, x: item.x, y: top, hasChildren: item.children.length > 0 });
      // A waypoint is a straight line through the row, joining the gaps above and below.
      else vline(center(item), top - 1, bottom + 1, item.origin);
    }
    y = bottom + 1;
    const next = rows[r + 1];
    if (!next) return;

    // Bundles of the segments into row r + 1.
    interface Bundle {
      sources: Item[];
      targets: Item[];
      from: string;
      lo: number;
      hi: number;
      track: number;
    }
    const bundles: Bundle[] = [];
    const bundled = new Set<string>();
    for (const target of next) {
      if (target.parents.length < 2) continue;
      bundles.push({ sources: target.parents, targets: [target], from: target.parents[0]!.origin, lo: 0, hi: 0, track: -1 });
      for (const s of target.parents) bundled.add(`${s.key}->${target.key}`);
    }
    for (const source of row) {
      const targets = source.children.filter((t) => !bundled.has(`${source.key}->${t.key}`));
      if (targets.length > 0) bundles.push({ sources: [source], targets, from: source.origin, lo: 0, hi: 0, track: -1 });
    }
    for (const b of bundles) {
      const xs = [...b.sources, ...b.targets].map(center);
      b.lo = Math.min(...xs);
      b.hi = Math.max(...xs);
    }
    // Greedy interval coloring; a straight drop needs no track.
    const trackEnds: number[] = [];
    for (const b of [...bundles].sort((a, c) => a.lo - c.lo || a.hi - c.hi)) {
      if (b.lo === b.hi) continue;
      let t = trackEnds.findIndex((end) => end < b.lo - 1);
      if (t === -1) t = trackEnds.push(b.hi) - 1;
      else trackEnds[t] = b.hi;
      b.track = t;
    }
    const gapTop = y;
    const arrowRow = gapTop + trackEnds.length;
    for (const b of bundles) {
      const trackY = b.track === -1 ? arrowRow : gapTop + b.track;
      for (const s of b.sources) vline(center(s), s.id === undefined ? gapTop - 1 : bottom, trackY, s.origin);
      if (b.track !== -1) hline(trackY, b.lo, b.hi, b.from);
      for (const t of b.targets) {
        vline(center(t), trackY, arrowRow, b.from);
        if (t.id !== undefined) strokes.get(`${center(t)},${arrowRow}`)!.arrow = true;
      }
    }
    y = arrowRow + 1;
  });

  return { width, height: y, nodes, strokes: [...strokes.values()] };
}

/**
 * Orders every row to reduce crossings: a few sweeps of the barycenter heuristic, down by parents then up by
 * children. The sort is stable, so ties keep the given order.
 */
function order(rows: Item[][]): void {
  const sweep = (r: number, neighbors: (item: Item) => Item[], ref: Item[]): void => {
    const pos = new Map(ref.map((item, i) => [item, i]));
    const bary = new Map(
      rows[r]!.map((item, i) => {
        const ns = neighbors(item).filter((n) => pos.has(n));
        return [item, ns.length === 0 ? i : ns.reduce((sum, n) => sum + pos.get(n)!, 0) / ns.length];
      }),
    );
    rows[r]!.sort((a, b) => bary.get(a)! - bary.get(b)!);
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < rows.length; r++) sweep(r, (item) => item.parents, rows[r - 1]!);
    for (let r = rows.length - 2; r >= 0; r--) sweep(r, (item) => item.children, rows[r + 1]!);
  }
  for (let r = 1; r < rows.length; r++) sweep(r, (item) => item.parents, rows[r - 1]!);
}
