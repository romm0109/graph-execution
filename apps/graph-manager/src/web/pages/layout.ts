// Pure layout state of the Terminals page: open tabs (terminals and runs), the 1/2/4-pane split, which item each pane
// shows and the focused pane. Saved in localStorage["gm.terminals.layout"].

export const LAYOUT_KEY = "gm.terminals.layout";

export type PaneCount = 1 | 2 | 4;
/** `t:<terminalId>` or `r:<workspaceId>/<runId>`. */
export type ItemId = string;

export interface LayoutState {
  layout: PaneCount;
  /** Open tabs, in tab-bar order. */
  tabs: ItemId[];
  /** What each of the 4 panes shows; only the first `layout` are visible. */
  panes: (ItemId | null)[];
  /** The focused pane, 0-based and < layout. */
  focused: number;
}

export type ParsedItem = { kind: "term"; id: string } | { kind: "run"; ws: string; runId: string };

export const termItem = (id: string): ItemId => `t:${id}`;
export const runItem = (ws: string, runId: string): ItemId => `r:${ws}/${runId}`;

export function parseItem(item: ItemId): ParsedItem | undefined {
  if (item.startsWith("t:") && item.length > 2) return { kind: "term", id: item.slice(2) };
  if (item.startsWith("r:")) {
    const rest = item.slice(2);
    const slash = rest.indexOf("/");
    if (slash > 0 && slash < rest.length - 1) return { kind: "run", ws: rest.slice(0, slash), runId: rest.slice(slash + 1) };
  }
  return undefined;
}

export function emptyLayout(): LayoutState {
  return { layout: 1, tabs: [], panes: [null, null, null, null], focused: 0 };
}

const LAYOUTS: PaneCount[] = [1, 2, 4];

/** The tabs not shown in a visible pane, in tab order. */
function hiddenTabs(s: LayoutState): ItemId[] {
  const visible = new Set(s.panes.slice(0, s.layout));
  return s.tabs.filter((t) => !visible.has(t));
}

/** Fills empty visible panes with tabs that aren't visible yet. */
function fill(s: LayoutState): LayoutState {
  const panes = [...s.panes];
  const spare = hiddenTabs(s);
  for (let i = 0; i < s.layout; i++) {
    if (panes[i] == null) panes[i] = spare.shift() ?? null;
  }
  return { ...s, panes };
}

/** The pane (0-based) showing `item` among the visible ones, or -1. */
export function paneOf(s: LayoutState, item: ItemId): number {
  return s.panes.slice(0, s.layout).indexOf(item);
}

/**
 * Opens `item` as a tab and shows it in `pane` (default: the focused one), which becomes focused. An item already
 * visible in another pane just takes the focus there.
 */
export function openItem(s: LayoutState, item: ItemId, pane?: number): LayoutState {
  const tabs = s.tabs.includes(item) ? s.tabs : [...s.tabs, item];
  const shown = paneOf(s, item);
  if (shown >= 0 && pane === undefined) return { ...s, tabs, focused: shown };
  const target = clampPane(pane ?? s.focused, s.layout);
  const panes = [...s.panes];
  if (shown >= 0) panes[shown] = panes[target] ?? null; // swap
  panes[target] = item;
  return { ...s, tabs, panes, focused: target };
}

/** Opens `item` in the first empty visible pane, else in pane 2 (splitting a single pane into two). */
export function openInNextFree(s: LayoutState, item: ItemId): LayoutState {
  const shown = paneOf(s, item);
  if (shown >= 0) return { ...s, focused: shown };
  let next = s;
  if (next.layout === 1) next = { ...next, layout: 2 };
  const free = next.panes.slice(0, next.layout).findIndex((p) => p == null);
  return openItem(next, item, free >= 0 ? free : 1);
}

/** Closes a tab; a pane that showed it takes the next hidden tab, if any. */
export function closeItem(s: LayoutState, item: ItemId): LayoutState {
  const tabs = s.tabs.filter((t) => t !== item);
  const panes = s.panes.map((p) => (p === item ? null : p));
  return fill({ ...s, tabs, panes });
}

export function setLayout(s: LayoutState, layout: PaneCount): LayoutState {
  return fill({ ...s, layout, focused: clampPane(s.focused, layout) });
}

/** 1 → 2 → 4 → 1. */
export function cycleLayout(s: LayoutState): LayoutState {
  return setLayout(s, LAYOUTS[(LAYOUTS.indexOf(s.layout) + 1) % LAYOUTS.length]!);
}

export function focusPane(s: LayoutState, pane: number): LayoutState {
  if (pane < 0 || pane >= s.layout) return s;
  return { ...s, focused: pane };
}

/** Drops tabs and pane assignments for which `exists` is false. */
export function prune(s: LayoutState, exists: (item: ItemId) => boolean): LayoutState {
  const tabs = s.tabs.filter(exists);
  if (tabs.length === s.tabs.length && s.panes.every((p) => p == null || exists(p))) return s;
  const keep = new Set(tabs);
  return fill({ ...s, tabs, panes: s.panes.map((p) => (p != null && keep.has(p) ? p : null)) });
}

function clampPane(i: number, layout: number): number {
  return Number.isInteger(i) && i >= 0 && i < layout ? i : 0;
}

/** Parses a saved layout; anything malformed gives the empty layout. */
export function parseLayout(raw: string | null | undefined): LayoutState {
  if (!raw) return emptyLayout();
  try {
    const v = JSON.parse(raw) as Partial<LayoutState>;
    const layout: PaneCount = LAYOUTS.includes(v.layout as PaneCount) ? (v.layout as PaneCount) : 1;
    const tabs = Array.isArray(v.tabs) ? [...new Set(v.tabs.filter((t): t is string => typeof t === "string" && parseItem(t) !== undefined))] : [];
    const set = new Set(tabs);
    const seen = new Set<string>();
    const panes: (ItemId | null)[] = [0, 1, 2, 3].map((i) => {
      const p = Array.isArray(v.panes) ? v.panes[i] : null;
      if (typeof p !== "string" || !set.has(p) || seen.has(p)) return null;
      seen.add(p);
      return p;
    });
    return { layout, tabs, panes, focused: clampPane(typeof v.focused === "number" ? v.focused : 0, layout) };
  } catch {
    return emptyLayout();
  }
}

export function loadLayout(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): LayoutState {
  try {
    return parseLayout(storage?.getItem(LAYOUT_KEY));
  } catch {
    return emptyLayout();
  }
}

export function saveLayout(s: LayoutState, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify(s));
  } catch {
    // private mode or quota: the layout just isn't remembered
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
