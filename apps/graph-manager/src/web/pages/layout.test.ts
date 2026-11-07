import { describe, expect, it } from "vitest";
import {
  LAYOUT_KEY,
  closeItem,
  cycleLayout,
  emptyLayout,
  focusPane,
  loadLayout,
  openInNextFree,
  openItem,
  parseItem,
  parseLayout,
  prune,
  runItem,
  saveLayout,
  setLayout,
  termItem,
} from "./layout";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe("layout", () => {
  it("parses item ids", () => {
    expect(parseItem(termItem("t3"))).toEqual({ kind: "term", id: "t3" });
    expect(parseItem(runItem("github~o~r", "20261106-1-44c2"))).toEqual({ kind: "run", ws: "github~o~r", runId: "20261106-1-44c2" });
    expect(parseItem("x:1")).toBeUndefined();
    expect(parseItem("r:nows")).toBeUndefined();
  });

  it("opens into the focused pane, focuses an already visible item, and swaps when told a pane", () => {
    let s = setLayout(emptyLayout(), 2);
    s = openItem(s, "t:a");
    expect(s.panes.slice(0, 2)).toEqual(["t:a", null]);
    s = focusPane(s, 1);
    s = openItem(s, "t:b");
    expect(s.panes.slice(0, 2)).toEqual(["t:a", "t:b"]);
    s = openItem(s, "t:a");
    expect(s.focused).toBe(0);
    s = openItem(s, "t:b", 0);
    expect(s.panes.slice(0, 2)).toEqual(["t:b", "t:a"]);
    expect(s.tabs).toEqual(["t:a", "t:b"]);
  });

  it("opens a run in the next free pane, else pane 2, splitting a single pane", () => {
    let s = openItem(emptyLayout(), "t:a");
    s = openInNextFree(s, "r:w/1");
    expect(s.layout).toBe(2);
    expect(s.panes.slice(0, 2)).toEqual(["t:a", "r:w/1"]);
    expect(s.focused).toBe(1);
    s = setLayout(s, 4);
    s = openInNextFree(s, "r:w/2");
    expect(s.panes[2]).toBe("r:w/2");
  });

  it("closing refills the pane from hidden tabs; layouts cycle 1 → 2 → 4 → 1 and clamp the focus", () => {
    let s = openItem(openItem(openItem(emptyLayout(), "t:a"), "t:b"), "t:c");
    expect(s.panes[0]).toBe("t:c");
    s = closeItem(s, "t:c");
    expect(s.tabs).toEqual(["t:a", "t:b"]);
    expect(s.panes[0]).toBe("t:a");
    s = cycleLayout(s);
    expect(s.layout).toBe(2);
    expect(s.panes.slice(0, 2)).toEqual(["t:a", "t:b"]);
    s = focusPane(cycleLayout(s), 3);
    expect(s.layout).toBe(4);
    expect(s.focused).toBe(3);
    s = cycleLayout(s);
    expect(s.layout).toBe(1);
    expect(s.focused).toBe(0);
    expect(focusPane(s, 2).focused).toBe(0);
  });

  it("persists, and drops unknown ids on load and on prune", () => {
    const store = memory();
    let s = openItem(openItem(setLayout(emptyLayout(), 2), "t:a"), "r:w/1", 1);
    saveLayout(s, store);
    expect(loadLayout(store)).toEqual(s);

    store.setItem(LAYOUT_KEY, JSON.stringify({ layout: 4, tabs: ["t:a", "bogus", 5, "t:a"], panes: ["t:a", "t:zzz", "t:a", null], focused: 9 }));
    expect(loadLayout(store)).toEqual({ layout: 4, tabs: ["t:a"], panes: ["t:a", null, null, null], focused: 0 });
    store.setItem(LAYOUT_KEY, "{not json");
    expect(loadLayout(store)).toEqual(emptyLayout());
    expect(parseLayout(JSON.stringify({ layout: 3 })).layout).toBe(1);

    s = prune(s, (item) => item !== "r:w/1");
    expect(s.tabs).toEqual(["t:a"]);
    expect(s.panes.slice(0, 2)).toEqual(["t:a", null]);
    expect(prune(s, () => true)).toBe(s);
  });
});
