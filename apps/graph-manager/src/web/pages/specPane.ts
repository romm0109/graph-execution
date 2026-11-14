// Pure state of the floating spec pane on the Terminals page: which spec to open as the focused workspace's specs
// change, and the pane's box (position and size inside the main area), saved in localStorage["gm.specPane"].

export const SPEC_BOX_KEY = "gm.specPane";

/** What the watch has seen of one workspace's specs since the page (or the workspace's focus) began. */
export interface SpecWatch {
  /** The newest `mtimeMs` seen; undefined until the first answer. */
  baseline?: number;
  latest?: { path: string; mtimeMs: number };
}

function newest<T extends { mtimeMs: number }>(specs: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const s of specs) if (!best || s.mtimeMs > best.mtimeMs) best = s;
  return best;
}

/**
 * Feeds one answer of the specs route into the watch. The first answer only sets the baseline (specs that existed
 * before do not open); later, a spec newer than the baseline is returned as `open`, once per change.
 */
export function nextWatch(prev: SpecWatch, specs: readonly { path: string; mtimeMs: number }[]): { watch: SpecWatch; open?: string } {
  const top = newest(specs);
  const latest = top ? { path: top.path, mtimeMs: top.mtimeMs } : undefined;
  if (prev.baseline === undefined) return { watch: { baseline: latest?.mtimeMs ?? 0, latest } };
  if (latest && latest.mtimeMs > prev.baseline) return { watch: { baseline: latest.mtimeMs, latest }, open: latest.path };
  return { watch: { baseline: prev.baseline, latest } };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_W = 320;
export const MIN_H = 200;
const MARGIN = 16;

/**
 * The default box in a view: the right side, 44 % wide, 70 % high, 16 px from the right edge and 16 px below `top`
 * (the tab bar, so its buttons stay reachable).
 */
export function defaultBox(view: { w: number; h: number }, top = 0): Box {
  const w = Math.round(view.w * 0.44);
  const h = Math.round(view.h * 0.7);
  return clampBox({ x: view.w - w - MARGIN, y: top + MARGIN, w, h }, view);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** At least 320×200 (or the whole view when it is smaller) and fully inside the view. */
export function clampBox(b: Box, view: { w: number; h: number }): Box {
  const vw = Math.max(0, view.w);
  const vh = Math.max(0, view.h);
  const num = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const w = Math.round(clamp(num(b.w, MIN_W), Math.min(MIN_W, vw), vw));
  const h = Math.round(clamp(num(b.h, MIN_H), Math.min(MIN_H, vh), vh));
  const x = Math.round(clamp(num(b.x, 0), 0, vw - w));
  const y = Math.round(clamp(num(b.y, 0), 0, vh - h));
  return { x, y, w, h };
}

/** A side or corner of the box the user drags to resize it. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * The box after dragging `edge` by (dx, dy): an east/south edge grows the size; a west/north edge moves the origin and
 * keeps the opposite edge in place, also when the minimum size or the view stops it. Clamped like `clampBox`.
 */
export function resizeBox(b: Box, edge: Edge, dx: number, dy: number, view: { w: number; h: number }): Box {
  let { x, y, w, h } = b;
  const right = b.x + b.w;
  const bottom = b.y + b.h;
  if (edge.includes("e")) w = Math.min(b.w + dx, view.w - b.x);
  if (edge.includes("s")) h = Math.min(b.h + dy, view.h - b.y);
  if (edge.includes("w")) {
    x = Math.max(0, Math.min(b.x + dx, right - Math.min(MIN_W, view.w)));
    w = right - x;
  }
  if (edge.includes("n")) {
    y = Math.max(0, Math.min(b.y + dy, bottom - Math.min(MIN_H, view.h)));
    h = bottom - y;
  }
  return clampBox({ x, y, w, h }, view);
}

/** The default box in a 1280×800 view. */
export const DEFAULT_BOX: Box = defaultBox({ w: 1280, h: 800 });

function parseBox(raw: string | null | undefined): Box | undefined {
  if (!raw) return undefined;
  const v = JSON.parse(raw) as unknown;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const ok = ["x", "y", "w", "h"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
  return ok ? { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number } : undefined;
}

/** The saved box, or undefined when none is saved (or it is unreadable). */
export function loadBox(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Box | undefined {
  try {
    return parseBox(storage?.getItem(SPEC_BOX_KEY));
  } catch {
    return undefined;
  }
}

export function saveBox(b: Box, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(SPEC_BOX_KEY, JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h }));
  } catch {
    // private mode or quota: the box just isn't remembered
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
