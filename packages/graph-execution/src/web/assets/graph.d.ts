// Types of `graph-execution/graph` (graph.js). Public API, covered by semver. See README › Embedding the graph.
// Changing GraphData, GraphOptions, the NodeStatus names, the `ge-` class names or the CSS custom properties that
// graph.css reads is a breaking change.

// ---- High-level API ----

/** Every status a node can have. Each has its own look in graph.css (class `ge-s-<status>`). */
export type NodeStatus =
  | "pending"
  | "queued"
  | "waiting"
  | "running"
  | "validating"
  | "fixing"
  | "merging"
  | "integrating"
  | "merged"
  | "done"
  | "applied"
  | "failed"
  | "aborted"
  | "stopped"
  | "human"
  | "skipped"
  | "excluded"
  /** Stopped and needs a human decision. */
  | "escalated"
  /** Removed from the plan. */
  | "dropped"
  /** Did not finish. */
  | "not_done";

export interface GraphNode {
  id: string;
  title: string;
  status: NodeStatus;
  provider?: string;
  /** ms since the epoch. A node with `startedAt` and no `endedAt` shows a live timer. */
  startedAt?: number;
  endedAt?: number;
  /** Shown as `×N` from the second attempt. */
  attempt?: number;
  /** The second-line status text, e.g. "checking 1/3". Shown in place of the provider. */
  detail?: string;
  changes?: { added: number; deleted: number; files: number };
}

export interface GraphEdge {
  /** A dependency of `to`. */
  from: string;
  to: string;
  /** Drawn dashed and dimmed. */
  blocked?: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  /** Default true. False is read-only: no selection and no pointer cursor; pan, zoom and the zoom bar still work. */
  interactive?: boolean;
  /** Called when the user clicks a node. Only when `interactive`. */
  onSelect?: (id: string) => void;
  /** The node drawn as selected. Clicking another node moves the selection. */
  selectedId?: string;
  /** Default true: running timers update every second, paused while the tab is hidden. */
  tickElapsed?: boolean;
  /**
   * Default "host": the F / 0 / + / − shortcuts work only while focus is inside the host (the host is made focusable).
   * "document": page-wide. false: no keyboard handling. Never while typing in an input.
   */
  keyboard?: "host" | "document" | false;
  /** The host's aria-label. Default "Task graph". */
  ariaLabel?: string;
}

export interface GraphHandle {
  /** Redraws. Keeps the user's pan and zoom, or fits when they never moved. */
  update(data: GraphData): void;
  /** Fits the whole graph in the host. The next `update` fits again until the user moves. */
  fit(): void;
  /** Removes every listener, timer and element it added. Safe to call twice. */
  destroy(): void;
}

/** Mounts a task graph in `host`. Give the host a size (for example `height: 480px`). */
export function mountGraph(host: HTMLElement, options?: GraphOptions): GraphHandle;

// ---- Low-level API (used by the engine's run and suite pages) ----

export interface Point {
  x: number;
  y: number;
}
export interface LayoutEdge {
  from: string;
  to: string;
  points: Point[];
}
export interface Layout {
  nodes: Map<string, Point>;
  width: number;
  height: number;
  edges: LayoutEdge[];
}
export interface LayoutOptions {
  nodeW?: number;
  nodeH?: number;
  gapX?: number;
  gapY?: number;
  pad?: number;
}

export const NODE_W: number;
export const NODE_H: number;
export const MIN_K: number;
export const MAX_K: number;
export const NARROW_FIT_PX: number;
export const NARROW_MIN_FIT_K: number;

/** Lays the layers out left to right, one column per layer. `parents[id]` are the dependencies of `id`. */
export function layoutLayers(layers: string[][], parents: Record<string, string[]>, opts?: LayoutOptions): Layout;
/** Kahn layering from edges; inside a layer, nodes keep their order in `ids`. */
export function layersFromEdges(ids: string[], edges: { from: string; to: string }[]): string[][];
export function edgePath(a: Point, b: Point, vertical?: boolean): string;
export function edgeClass(fromStatus: string | undefined, toStatus: string | undefined): string;
export function nodeClass(status: string): string;
export function formatElapsed(ms: number): string;
export function svg(
  tag: string,
  attrs?: Record<string, string | number | undefined> | null,
  ...children: (Node | string | null | undefined)[]
): SVGElement;
export function renderEdge(
  a: Point,
  b: Point,
  opts?: { from?: string; to?: string; vertical?: boolean; blocked?: boolean },
): SVGElement;

export interface NodeCardView {
  status: string;
  attempt?: number;
  attempts?: number;
  changes?: { total?: { added: number; deleted: number; files: number } };
  startedAt?: number;
  endedAt?: number;
}
export interface NodeCardOptions {
  id: string;
  title: string;
  x: number;
  y: number;
  provider?: string;
  now?: number;
  selected?: boolean;
  retryable?: boolean;
  detail?: string;
  badge?: string;
  /** Without the `ge-` prefix, e.g. "warn". */
  badgeClass?: string;
  resumed?: string;
  /** Default true. False: no `ge-clickable`, and `aria-disabled`. */
  interactive?: boolean;
}
export function renderNodeCard(view: NodeCardView, opts: NodeCardOptions): SVGElement;
/** Refreshes the elapsed texts of cards under `root` that have not ended. */
export function tickElapsed(root: ParentNode, now?: number): void;
export function pinchView(
  start: { x: number; y: number; k: number },
  from: [Point, Point],
  to: [Point, Point],
): { x: number; y: number; k: number };

export interface CanvasOptions {
  onSelect?: (id: string, ev: MouseEvent) => void;
  /** Default true. */
  interactive?: boolean;
  /** Default "document". */
  keyboard?: "host" | "document" | false;
  /** Default false: fit only on the first `setContent`. True: fit on every `setContent` until the user moves. */
  refit?: boolean;
}
export interface Canvas {
  svg: SVGElement;
  root: SVGElement;
  fit(): void;
  zoomBy(f: number): void;
  reset(): void;
  setContent(width: number, height: number): void;
  destroy(): void;
}
export function createCanvas(host: HTMLElement, opts?: CanvasOptions): Canvas;
