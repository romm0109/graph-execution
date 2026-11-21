// @ts-check
/// <reference lib="dom" />
// The run graph: pure layout, node cards, edges, the pan/zoom controller, and `mountGraph` for embedding.
// Shared by the run and suite pages, and published as `graph-execution/graph` (types: graph.d.ts).
// Public API, covered by semver. See README › Embedding the graph. No imports: it runs in the browser as is.

const SVGNS = "http://www.w3.org/2000/svg";

export const NODE_W = 220;
export const NODE_H = 64;

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ from: string, to: string, points: Point[] }} LayoutEdge
 * @typedef {{ nodes: Map<string, Point>, width: number, height: number, edges: LayoutEdge[] }} Layout
 * @typedef {{ nodeW?: number, nodeH?: number, gapX?: number, gapY?: number, pad?: number }} LayoutOptions
 */

// ---- Pure layout ----

/**
 * Lays the layers out left to right: one column per layer, the nodes of a column centred vertically.
 * Each parent link is an edge from the parent's right side to the child's left side.
 * @param {string[][]} layers
 * @param {Record<string, string[]>} parents
 * @param {LayoutOptions} [opts]
 * @returns {Layout}
 */
export function layoutLayers(layers, parents, opts = {}) {
  const { nodeW = NODE_W, nodeH = NODE_H, gapX = 56, gapY = 24, pad = 24 } = opts;
  const tallest = Math.max(1, ...layers.map((l) => l.length));
  const innerH = tallest * nodeH + (tallest - 1) * gapY;
  const width = pad * 2 + layers.length * nodeW + Math.max(0, layers.length - 1) * gapX;
  const height = pad * 2 + innerH;
  /** @type {Map<string, Point>} */
  const nodes = new Map();
  layers.forEach((layer, col) => {
    const colH = layer.length * nodeH + (layer.length - 1) * gapY;
    const y0 = pad + (innerH - colH) / 2;
    layer.forEach((id, i) => nodes.set(id, { x: pad + col * (nodeW + gapX), y: y0 + i * (nodeH + gapY) }));
  });
  /** @type {LayoutEdge[]} */
  const edges = [];
  for (const to of Object.keys(parents)) {
    const b = nodes.get(to);
    if (!b) continue;
    for (const from of parents[to] || []) {
      const a = nodes.get(from);
      if (!a) continue;
      edges.push({ from, to, points: [{ x: a.x + nodeW, y: a.y + nodeH / 2 }, { x: b.x, y: b.y + nodeH / 2 }] });
    }
  }
  return { nodes, width, height, edges };
}

/** Length of the arrow head, which the edge stops short of. */
const ARROW = 7;

/**
 * A bezier from `a` to `b`, ending `ARROW` px short of `b` for the arrow head.
 * Leaves `a` horizontally (to the right) unless `vertical`, where it leaves downwards.
 * @param {Point} a
 * @param {Point} b
 * @param {boolean} [vertical]
 */
export function edgePath(a, b, vertical = false) {
  if (vertical) {
    const my = (a.y + b.y) / 2;
    return `M${a.x} ${a.y} C${a.x} ${my} ${b.x} ${my} ${b.x} ${b.y - ARROW}`;
  }
  const mx = (a.x + b.x) / 2;
  return `M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x - ARROW} ${b.y}`;
}

const OK_STATUS = new Set(["merged", "done", "applied"]);
const ACTIVE_TARGET = new Set(["running", "integrating"]);

/**
 * CSS classes of an edge: `ge-active` when its target runs, `ge-dim` out of a failed node, `ge-ok` out of a finished one.
 * @param {string | undefined} fromStatus
 * @param {string | undefined} toStatus
 */
export function edgeClass(fromStatus, toStatus) {
  const mods = [];
  if (toStatus && ACTIVE_TARGET.has(toStatus)) mods.push("ge-active");
  if (fromStatus === "failed" || fromStatus === "aborted") mods.push("ge-dim");
  else if (fromStatus && OK_STATUS.has(fromStatus)) mods.push("ge-ok");
  return mods.join(" ");
}

/** The class of a node group: `ge-node ge-s-<status>`. */
export function nodeClass(/** @type {string} */ status) {
  return `ge-node ge-s-${status}`;
}

// ---- Formatting ----

/** `m:ss`, or `h:mm:ss` from one hour. */
export function formatElapsed(/** @type {number} */ ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}
const compact = (/** @type {number} */ n) => (n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n));
const truncate = (/** @type {string} */ s, /** @type {number} */ max) =>
  s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;

// ---- SVG helpers ----

/**
 * Creates an SVG element; children are nodes or strings (text).
 * @param {string} tag
 * @param {Record<string, string | number | undefined> | null} [attrs]
 * @param {...(Node | string | null | undefined)} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs, ...children) {
  const e = /** @type {SVGElement} */ (document.createElementNS(SVGNS, tag));
  for (const k in attrs || {}) {
    const val = /** @type {Record<string, string | number | undefined>} */ (attrs)[k];
    if (val !== undefined) e.setAttribute(k, String(val));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

/** Statuses whose square mark is drawn hollow (not started, or left out); the rest are filled. The active ones get a spinner. */
const HOLLOW = new Set(["pending", "queued", "waiting", "excluded", "skipped", "dropped"]);
const SPINNING = new Set(["running", "validating", "fixing", "merging", "integrating"]);
const SPIN_MS = 900;

/**
 * An edge: the curve and its arrow head. A `blocked` edge is dashed, dimmed and never animated.
 * @param {Point} a
 * @param {Point} b
 * @param {{ from?: string, to?: string, vertical?: boolean, blocked?: boolean }} [opts] statuses of both ends
 */
export function renderEdge(a, b, opts = {}) {
  const { from, to, vertical = false, blocked = false } = opts;
  let mods = edgeClass(from, to);
  if (blocked) mods = [...mods.split(" ").filter((m) => m && m !== "ge-active"), "ge-blocked"].join(" ");
  const cls = (/** @type {string} */ base) => (mods ? `${base} ${mods}` : base);
  const phase = `animation-delay: -${Math.round(performance.now() % 800)}ms`;
  const arrow = vertical
    ? `M${b.x - 4} ${b.y - ARROW} L${b.x} ${b.y} L${b.x + 4} ${b.y - ARROW} Z`
    : `M${b.x - ARROW} ${b.y - 4} L${b.x} ${b.y} L${b.x - ARROW} ${b.y + 4} Z`;
  return svg("g", null, svg("path", { class: cls("ge-edge"), d: edgePath(a, b, vertical), style: phase }), svg("path", { class: cls("ge-arrow"), d: arrow }));
}

/**
 * A node card of NODE_W × NODE_H. Line 1: the status icon and title; line 2: provider, elapsed time,
 * attempt and the changed lines. Elapsed texts carry `data-start` (and `data-end`) for `tickElapsed`.
 * @param {{ status: string, attempt?: number, attempts?: number, changes?: { total?: { added: number, deleted: number, files: number } }, startedAt?: number, endedAt?: number }} view
 * @param {{ id: string, title: string, x: number, y: number, provider?: string, now?: number, selected?: boolean, retryable?: boolean, detail?: string, badge?: string, badgeClass?: string, resumed?: string, interactive?: boolean }} opts
 *   `detail` is the status text (a fix round, a wait), shown first on line 2 in place of the provider; `badge` is
 *   shown at the right of line 1; `resumed` (KAN-97) adds "reused" or "ran again" to line 2. `interactive: false`
 *   draws a read-only card: no `ge-clickable`, and `aria-disabled`. Cards are never focusable.
 * @returns {SVGElement}
 */
export function renderNodeCard(view, opts) {
  const { id, title, x, y, provider, now = Date.now(), selected = false, retryable = false, badge, badgeClass, resumed, interactive = true } = opts;
  const status = view.status;
  // An escalated task waits for a human: say so when the caller has nothing more specific.
  const detail = opts.detail || (status === "escalated" ? "needs decision" : undefined);
  const g = svg("g", {
    class: `${nodeClass(status)}${interactive ? " ge-clickable" : ""}${selected ? " ge-sel" : ""}${retryable ? " ge-retryable" : ""}`,
    "data-node-id": id,
    "aria-disabled": interactive ? undefined : "true",
    transform: `translate(${x} ${y})`,
  });
  g.append(svg("title", null, [title, detail || status].join("\n")));
  g.append(svg("rect", { width: NODE_W, height: NODE_H, rx: 8 }));

  if (SPINNING.has(status)) {
    g.append(
      svg("g", { transform: "translate(22 24)" }, svg("path", {
        class: "ge-spin", style: `animation-delay: -${Math.round(performance.now() % SPIN_MS)}ms`,
        d: "M0 -5 A5 5 0 1 1 -5 0", fill: "none", stroke: "var(--ge-c)", "stroke-width": 2,
      })),
    );
  } else g.append(svg("rect", { class: HOLLOW.has(status) ? "ge-mark ge-hollow" : "ge-mark", x: 18, y: 20, width: 8, height: 8, rx: 2 }));

  // The state text (`fixing 1/3`, `checking fix 1/3`) goes on the second line, so it never runs into a long title;
  // only a short badge shares the first line with the title.
  const rightText = badge ? truncate(badge, 14) : "";
  g.append(svg("text", { class: "ge-ttl", x: 34, y: 28 }, truncate(title, rightText ? 15 : 24)));
  if (rightText) g.append(svg("text", { class: badgeClass ? `ge-badge ge-${badgeClass}` : "ge-badge", x: NODE_W - 12, y: 28, "text-anchor": "end" }, rightText));

  const tot = view.changes && view.changes.total;
  const hasTot = !!tot && tot.files > 0;
  const info = svg("text", { class: "ge-meta", x: 16, y: 49 });
  const parts = [];
  if (detail) parts.push(svg("tspan", { class: "ge-detail" }, truncate(detail, 16)));
  else if (provider) parts.push(svg("tspan", null, truncate(provider, hasTot ? 8 : 14)));
  if (view.startedAt !== undefined) {
    const end = view.endedAt;
    parts.push(svg("tspan", {
      class: "ge-el", "data-start": view.startedAt, "data-end": end,
    }, formatElapsed((end ?? now) - view.startedAt)));
  }
  if ((view.attempts ?? 0) > 0 && (view.attempt ?? 0) > 1) parts.push(svg("tspan", { class: "ge-tries" }, `×${view.attempt}`));
  // KAN-97: after a resume, whether the node kept its earlier result or ran again.
  if (resumed) parts.push(svg("tspan", { class: `ge-resumed ge-${resumed}`, "data-resumed": resumed }, resumed === "reused" ? "reused" : "ran again"));
  parts.forEach((p, i) => {
    if (i > 0) info.append(" · ");
    info.append(p);
  });
  g.append(info);
  if (hasTot && tot) {
    g.append(svg("text", { class: "ge-meta", x: NODE_W - 12, y: 49, "text-anchor": "end" },
      svg("tspan", { class: "ge-add" }, `+${compact(tot.added)}`), svg("tspan", { class: "ge-del" }, ` −${compact(tot.deleted)}`)));
  }
  return g;
}

/**
 * Refreshes the elapsed texts of cards that have not ended.
 * @param {ParentNode} root
 * @param {number} [now]
 */
export function tickElapsed(root, now = Date.now()) {
  for (const e of Array.from(root.querySelectorAll(".ge-el[data-start]"))) {
    if (e.getAttribute("data-end") !== null) continue;
    e.textContent = formatElapsed(now - Number(e.getAttribute("data-start")));
  }
}

// ---- Canvas controller ----

export const MIN_K = 0.15;
export const MAX_K = 2.5;
/** Below this host width, fit never zooms out further than NARROW_MIN_FIT_K. */
export const NARROW_FIT_PX = 600;
export const NARROW_MIN_FIT_K = 0.6;

/**
 * The view after a two-finger pinch: the content point under the starting midpoint ends up under the current
 * midpoint, and the scale changes by the ratio of the finger distances, clamped to MIN_K … MAX_K.
 * Points are in host pixels. Returns a copy of `start` when the starting fingers are on the same spot.
 * @param {{ x: number, y: number, k: number }} start the view when the second finger went down
 * @param {[Point, Point]} from the two finger positions then
 * @param {[Point, Point]} to the two finger positions now
 * @returns {{ x: number, y: number, k: number }}
 */
export function pinchView(start, from, to) {
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  if (d0 === 0) return { ...start };
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  const k = Math.max(MIN_K, Math.min(MAX_K, start.k * (d1 / d0)));
  const m0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const m1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const cx = (m0.x - start.x) / start.k, cy = (m0.y - start.y) / start.k;
  return { x: m1.x - cx * k, y: m1.y - cy * k, k };
}

/** Whether the keyboard focus is in a text field, where the canvas shortcuts must stay quiet. */
function typing(/** @type {EventTarget | null} */ t) {
  const el = /** @type {HTMLElement | null} */ (t);
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

/**
 * Pan, zoom and fit for an SVG graph inside `host`. The page draws into `root`, then calls `setContent`.
 * `interactive: false` makes it read-only: no `onSelect`, and a double-click on empty space does not re-fit; pan, zoom
 * and the zoom bar still work. `keyboard` scopes the F / 0 / + / − shortcuts: `"document"` (the default, the engine's
 * pages) listens page-wide, `"host"` only while focus is inside the host (which becomes focusable), `false` not at all.
 * `refit: true` re-fits on every `setContent` until the user pans or zooms (the engine's pages fit only the first
 * time). `destroy()` removes every listener, the observer and the elements it added.
 * @param {HTMLElement} host a positioned, overflow-hidden element
 * @param {{ onSelect?: (id: string, ev: MouseEvent) => void, interactive?: boolean, keyboard?: "host" | "document" | false, refit?: boolean }} [opts]
 */
export function createCanvas(host, opts = {}) {
  const { onSelect, interactive = true, keyboard = "document", refit = false } = opts;
  const view = { x: 0, y: 0, k: 1 };
  const size = { width: 0, height: 0 };
  let placed = false;
  let moved = false; // the user panned or zoomed since the last fit
  /** @type {{ id: number, sx: number, sy: number, vx: number, vy: number, moved: boolean } | null} */
  let drag = null;
  let suppressClick = false;
  // Every listener on the host and the zoom bar goes away with this signal; the document one is removed by hand.
  const listeners = new AbortController();
  const { signal } = listeners;

  const root = svg("g");
  const el = svg("svg", { role: "img", class: "ge-canvas-svg" }, root);
  host.classList.add("ge-canvas");
  host.prepend(el);

  const apply = () => {
    el.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  };
  const box = () => host.getBoundingClientRect();

  const fit = () => {
    const b = box();
    if (b.width === 0 || size.width === 0) return;
    const pad = 24;
    // On a phone, fitting a whole graph makes the nodes unreadable: keep a readable minimum and let the user pan.
    const floor = b.width < NARROW_FIT_PX ? NARROW_MIN_FIT_K : MIN_K;
    const k = Math.max(floor, Math.min(1, (b.width - pad) / size.width, (b.height - pad) / size.height));
    view.k = k;
    view.x = Math.max(pad / 2, (b.width - size.width * k) / 2);
    view.y = Math.max(pad / 2, (b.height - size.height * k) / 2);
    placed = true;
    moved = false;
    apply();
  };
  /** Zooms by `f` keeping the point (cx, cy), in host pixels, fixed. */
  const zoomAt = (/** @type {number} */ f, /** @type {number} */ cx, /** @type {number} */ cy) => {
    const k = Math.max(MIN_K, Math.min(MAX_K, view.k * f));
    view.x = cx - (cx - view.x) * (k / view.k);
    view.y = cy - (cy - view.y) * (k / view.k);
    view.k = k;
    moved = true;
    apply();
  };
  const zoomBy = (/** @type {number} */ f) => {
    const b = box();
    zoomAt(f, b.width / 2, b.height / 2);
  };
  const reset = () => {
    const b = box();
    const cx = (b.width / 2 - view.x) / view.k;
    const cy = (b.height / 2 - view.y) / view.k;
    view.k = 1;
    view.x = b.width / 2 - cx;
    view.y = b.height / 2 - cy;
    moved = true;
    apply();
  };
  const setContent = (/** @type {number} */ width, /** @type {number} */ height) => {
    size.width = width;
    size.height = height;
    el.setAttribute("width", String(width));
    el.setAttribute("height", String(height));
    el.setAttribute("viewBox", `0 0 ${width} ${height}`);
    if (!placed || (refit && !moved)) fit();
    else apply();
  };

  // Floating controls
  const zoombar = document.createElement("div");
  zoombar.className = "ge-zoombar";
  /** @type {Array<[string, string, () => void]>} */
  const buttons = [["−", "Zoom out", () => zoomBy(1 / 1.2)], ["+", "Zoom in", () => zoomBy(1.2)], ["Fit", "Fit to view (F)", fit], ["1:1", "Actual size (0)", reset]];
  for (const [label, tip, run] of buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = tip;
    b.setAttribute("aria-label", tip);
    b.addEventListener("click", run, { signal });
    zoombar.append(b);
  }
  host.append(zoombar);

  // Pointer: one pointer drags to pan, two touch pointers pinch to zoom.
  /** @type {Map<number, Point>} active touch pointers, in host pixels */
  const touches = new Map();
  /** @type {{ start: { x: number, y: number, k: number }, from: [Point, Point], ids: [number, number] } | null} */
  let pinch = null;
  const hostPoint = (/** @type {PointerEvent} */ ev) => {
    const b = box();
    return { x: ev.clientX - b.left, y: ev.clientY - b.top };
  };
  host.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || /** @type {Element} */ (ev.target).closest(".ge-zoombar")) return;
    // A fresh gesture: a pinch leaves no click behind to clear the flag, so the next tap must not be swallowed.
    if (touches.size === 0 && !drag) suppressClick = false;
    if (ev.pointerType === "touch") {
      touches.set(ev.pointerId, hostPoint(ev));
      if (touches.size > 2 || pinch) return; // a third finger starts nothing
      if (touches.size === 2) {
        const [[id0, p0], [id1, p1]] = /** @type {[[number, Point], [number, Point]]} */ (Array.from(touches.entries()));
        pinch = { start: { ...view }, from: [p0, p1], ids: [id0, id1] };
        drag = null;
        host.classList.remove("ge-panning");
        suppressClick = true; // a pinch is never a tap
        capture(ev.pointerId);
        return;
      }
    }
    drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
  }, { signal });
  // jsdom and old browsers have no pointer capture; panning still works without it while the pointer stays inside.
  const capture = (/** @type {number} */ id) => {
    try {
      if (typeof host.setPointerCapture === "function") host.setPointerCapture(id);
    } catch {
      // The pointer is already gone.
    }
  };
  host.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "touch" && touches.has(ev.pointerId)) touches.set(ev.pointerId, hostPoint(ev));
    if (pinch) {
      const a = touches.get(pinch.ids[0]), b = touches.get(pinch.ids[1]);
      if (a && b && pinch.ids.includes(ev.pointerId)) {
        const v = pinchView(pinch.start, pinch.from, [a, b]);
        view.x = v.x;
        view.y = v.y;
        view.k = v.k;
        moved = true;
        apply();
      }
      return;
    }
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < (ev.pointerType === "touch" ? 10 : 4)) return;
    if (!drag.moved) {
      drag.moved = true;
      capture(ev.pointerId);
      host.classList.add("ge-panning");
    }
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    moved = true;
    apply();
  }, { signal });
  const end = (/** @type {PointerEvent} */ ev) => {
    touches.delete(ev.pointerId);
    // The finger left after a pinch does not resume panning; the next pointerdown starts afresh.
    if (pinch && pinch.ids.includes(ev.pointerId)) pinch = null;
    if (!drag || ev.pointerId !== drag.id) return;
    // A drag is not a click on the node it started on.
    if (drag.moved) suppressClick = true;
    host.classList.remove("ge-panning");
    drag = null;
  };
  host.addEventListener("pointerup", end, { signal });
  host.addEventListener("pointercancel", end, { signal });

  // Wheel zooms at the cursor; the trackpad's pinch arrives as ctrl+wheel with finer deltas.
  host.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const b = box();
    zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - b.left, ev.clientY - b.top);
  }, { passive: false, signal });
  host.addEventListener("dblclick", (ev) => {
    if (!interactive) return; // read-only: clicking empty space leaves the view alone
    const t = /** @type {Element} */ (ev.target);
    if (!t.closest("[data-node-id]") && !t.closest(".ge-zoombar")) fit();
  }, { signal });
  host.addEventListener("click", (ev) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (!interactive) return;
    const node = /** @type {Element} */ (ev.target).closest("[data-node-id]");
    if (node && onSelect) onSelect(/** @type {string} */ (node.getAttribute("data-node-id")), ev);
  }, { signal });

  // Keyboard
  const onKey = (/** @type {KeyboardEvent} */ ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
    if (ev.key === "f" || ev.key === "F") fit();
    else if (ev.key === "+" || ev.key === "=") zoomBy(1.2);
    else if (ev.key === "-" || ev.key === "_") zoomBy(1 / 1.2);
    else if (ev.key === "0") reset();
    else return;
    ev.preventDefault();
  };
  const addedTabindex = keyboard === "host" && !host.hasAttribute("tabindex");
  if (addedTabindex) host.setAttribute("tabindex", "0");
  if (keyboard === "host") host.addEventListener("keydown", onKey, { signal });
  else if (keyboard === "document") document.addEventListener("keydown", onKey);

  // Keep the graph fitted while the container changes size, unless the user took the view elsewhere.
  /** @type {ResizeObserver | null} */
  let observer = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (!placed || !moved) fit();
    });
    observer.observe(host);
  }

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    listeners.abort();
    if (keyboard === "document") document.removeEventListener("keydown", onKey);
    if (observer) observer.disconnect();
    el.remove();
    zoombar.remove();
    host.classList.remove("ge-canvas", "ge-panning");
    if (addedTabindex) host.removeAttribute("tabindex");
  };

  return { svg: el, root, fit, zoomBy, reset, setContent, destroy };
}

// ---- Embedding: mountGraph ----

/**
 * Groups the nodes into layers so that every node's dependencies sit in earlier layers (Kahn's algorithm, as the
 * engine's `executionLayers`). Inside a layer, nodes keep their order in `ids`. Edges to unknown ids are ignored.
 * Nodes caught in a cycle go into one last layer, in input order, with a console warning.
 * @param {string[]} ids
 * @param {{ from: string, to: string }[]} edges `from` is a dependency of `to`
 * @returns {string[][]}
 */
export function layersFromEdges(ids, edges) {
  const known = new Set(ids);
  /** @type {Map<string, Set<string>>} */
  const deps = new Map();
  for (const id of ids) if (!deps.has(id)) deps.set(id, new Set());
  for (const e of edges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue;
    /** @type {Set<string>} */ (deps.get(e.to)).add(e.from);
  }
  /** @type {string[][]} */
  const layers = [];
  while (deps.size > 0) {
    const ready = [...deps.keys()].filter((id) => /** @type {Set<string>} */ (deps.get(id)).size === 0);
    if (ready.length === 0) {
      console.warn("graph-execution/graph: the edges have a cycle; its nodes are drawn in the last column:", [...deps.keys()]);
      layers.push([...deps.keys()]);
      break;
    }
    for (const id of ready) deps.delete(id);
    for (const d of deps.values()) for (const id of ready) d.delete(id);
    layers.push(ready);
  }
  return layers;
}

/**
 * Mounts a task graph in `host` (give it a size). Public API: see README › Embedding the graph.
 * @param {HTMLElement} host
 * @param {{ interactive?: boolean, onSelect?: (id: string) => void, selectedId?: string, tickElapsed?: boolean, keyboard?: "host" | "document" | false, ariaLabel?: string }} [options]
 */
export function mountGraph(host, options = {}) {
  const { interactive = true, onSelect, tickElapsed: tick = true, keyboard = "host", ariaLabel = "Task graph" } = options;
  let selectedId = options.selectedId;
  /** @type {{ nodes: any[], edges: { from: string, to: string, blocked?: boolean }[] } | null} */
  let data = null;
  let destroyed = false;

  const had = { role: host.getAttribute("role"), label: host.getAttribute("aria-label") };
  host.classList.add("ge-graph");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", ariaLabel);

  const canvas = createCanvas(host, {
    interactive,
    keyboard,
    refit: true,
    onSelect: (id) => {
      selectedId = id;
      if (data) draw(data);
      if (onSelect) onSelect(id);
    },
  });

  const draw = (/** @type {NonNullable<typeof data>} */ d) => {
    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const n of d.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    const ids = [...byId.keys()];
    /** @type {Record<string, string[]>} */
    const parents = {};
    /** @type {Set<string>} */
    const blocked = new Set();
    for (const e of d.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      (parents[e.to] ||= []).push(e.from);
      if (e.blocked) blocked.add(`${e.from}\n${e.to}`);
    }
    const lay = layoutLayers(layersFromEdges(ids, d.edges), parents);
    const edges = svg("g");
    for (const e of lay.edges) {
      edges.append(renderEdge(/** @type {Point} */ (e.points[0]), /** @type {Point} */ (e.points[1]), {
        from: byId.get(e.from).status, to: byId.get(e.to).status, blocked: blocked.has(`${e.from}\n${e.to}`),
      }));
    }
    const cards = svg("g");
    const now = Date.now();
    for (const [id, p] of lay.nodes) {
      const n = byId.get(id);
      cards.append(renderNodeCard(
        { status: n.status, attempt: n.attempt, attempts: n.attempt ?? 0, startedAt: n.startedAt, endedAt: n.endedAt, changes: n.changes ? { total: n.changes } : undefined },
        { id, title: n.title, x: p.x, y: p.y, provider: n.provider, detail: n.detail, now, selected: id === selectedId, interactive },
      ));
    }
    canvas.root.replaceChildren(edges, cards);
    canvas.setContent(lay.width, lay.height);
  };

  // Live timers: one tick a second, paused while the tab is hidden.
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  const start = () => {
    if (timer === null) timer = setInterval(() => tickElapsed(host), 1000);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (document.hidden) stop();
    else {
      tickElapsed(host);
      start();
    }
  };
  if (tick) {
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();
  }

  return {
    /** Redraws; keeps the user's pan and zoom, or fits when they never moved. */
    update(/** @type {NonNullable<typeof data>} */ next) {
      if (destroyed) return;
      data = next;
      draw(next);
      if (tick) tickElapsed(host);
    },
    fit() {
      if (!destroyed) canvas.fit();
    },
    /** Removes every listener, timer and element it added. Safe to call twice. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      if (tick) document.removeEventListener("visibilitychange", onVisibility);
      canvas.destroy();
      host.classList.remove("ge-graph");
      if (had.role === null) host.removeAttribute("role");
      else host.setAttribute("role", had.role);
      if (had.label === null) host.removeAttribute("aria-label");
      else host.setAttribute("aria-label", had.label);
    },
  };
}
