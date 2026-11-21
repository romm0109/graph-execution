// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  layersFromEdges,
  layoutLayers,
  mountGraph,
  renderEdge,
  renderNodeCard,
  type GraphData,
  type GraphOptions,
  type NodeStatus,
} from "./graph.js";

// jsdom has no ResizeObserver: record what the graph observes and disconnects.
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  connected = false;
  constructor(readonly cb: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

let hidden = false;
beforeEach(() => {
  FakeResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** A host with a size: jsdom lays nothing out, so fit() needs a stubbed box. */
function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) });
  document.body.append(host);
  return host;
}
const svgOf = (host: HTMLElement) => host.querySelector("svg.ge-canvas-svg") as SVGSVGElement;
const transform = (host: HTMLElement) => svgOf(host).style.transform;
const fire = (target: EventTarget, type: string, init: Record<string, unknown> = {}) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  for (const [k, v] of Object.entries(init)) if (!(k in ev)) Object.defineProperty(ev, k, { value: v });
  target.dispatchEvent(ev);
};
const key = (target: EventTarget, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

const diamond = (): GraphData => ({
  nodes: [
    { id: "a", title: "a", status: "merged" },
    { id: "b", title: "b", status: "running", startedAt: Date.now() - 5000 },
    { id: "c", title: "c", status: "pending" },
    { id: "d", title: "d", status: "pending" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "d", blocked: true },
  ],
});

describe("layout", () => {
  it("gives the run page's positions for the run page's graph", () => {
    // The run page's model: task layers (ids sorted, as executionLayers does), then the review pipeline.
    const layers = [["1"], ["2", "3"], ["4"], ["@gate"], ["@reviewer", "@tester"], ["@fixer"], ["@merge"]];
    const parents: Record<string, string[]> = {
      "2": ["1"], "3": ["1"], "4": ["2", "3"], "@gate": ["4"], "@reviewer": ["@gate"], "@tester": ["@gate"],
      "@fixer": ["@reviewer", "@tester"], "@merge": ["@fixer"],
    };
    const ids = layers.flat();
    const edges = Object.entries(parents).flatMap(([to, from]) => from.map((f) => ({ from: f, to })));
    expect(layersFromEdges(ids, edges)).toEqual(layers);
    const runPage = layoutLayers(layers, parents);
    const mounted = layoutLayers(layersFromEdges(ids, edges), parents);
    expect([...mounted.nodes]).toEqual([...runPage.nodes]);
    expect(mounted.width).toBe(runPage.width);
    expect(mounted.height).toBe(runPage.height);
  });

  it("keeps the input order inside a layer", () => {
    expect(layersFromEdges(["z", "y", "x"], [{ from: "z", to: "x" }])).toEqual([["z", "y"], ["x"]]);
  });

  it("does not throw on a cycle and skips edges to unknown nodes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(layersFromEdges(["a", "b", "c"], [{ from: "b", to: "c" }, { from: "c", to: "b" }, { from: "ghost", to: "a" }])).toEqual([["a"], ["b", "c"]]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("draws one card per node and one edge per edge whose ends exist", () => {
    const host = makeHost();
    const g = mountGraph(host, { tickElapsed: false });
    g.update({ ...diamond(), edges: [...diamond().edges, { from: "a", to: "ghost" }] });
    expect(host.querySelectorAll("[data-node-id]")).toHaveLength(4);
    expect(host.querySelectorAll("path.ge-edge")).toHaveLength(4);
    g.destroy();
  });
});

const ALL: NodeStatus[] = [
  "pending", "queued", "waiting", "running", "validating", "fixing", "merging", "integrating", "merged", "done", "applied",
  "failed", "aborted", "stopped", "human", "skipped", "excluded", "escalated", "dropped", "not_done",
];

describe("snapshots", () => {
  const card = (status: string, interactive = true) =>
    renderNodeCard(
      { status, attempt: 2, attempts: 2, startedAt: 1000, endedAt: 61_000, changes: { total: { added: 12, deleted: 3, files: 2 } } },
      { id: "t1", title: "Add the thing", x: 0, y: 0, provider: "claude", now: 61_000, interactive },
    ).outerHTML;

  it.each(ALL)("card for %s", (status) => {
    expect(card(status)).toMatchSnapshot();
  });

  it("read-only vs interactive card", () => {
    expect(card("running", false)).toMatchSnapshot();
    expect(card("running", true)).toMatchSnapshot();
    expect(card("running", false)).not.toContain("ge-clickable");
    expect(card("running", false)).toContain('aria-disabled="true"');
    expect(card("running", true)).toContain("ge-clickable");
  });

  it("normal vs blocked edge", () => {
    const normal = renderEdge({ x: 0, y: 0 }, { x: 100, y: 50 }, { from: "merged", to: "running" }).outerHTML;
    const blocked = renderEdge({ x: 0, y: 0 }, { x: 100, y: 50 }, { from: "merged", to: "running", blocked: true }).outerHTML;
    expect(normal).toMatchSnapshot();
    expect(blocked).toMatchSnapshot();
    expect(blocked).toContain("ge-blocked");
    expect(blocked).not.toContain("ge-active");
  });

  it("escalated, dropped and not_done look different from each other and from failed and skipped", () => {
    const strip = (s: string) => s.replace(/ge-s-[a-z_]+/, "");
    expect(card("escalated")).toContain("needs decision");
    expect(card("dropped")).toContain("ge-hollow");
    const looks = ["escalated", "dropped", "not_done", "failed", "skipped"].map((s) => card(s));
    expect(new Set(looks).size).toBe(5);
    // Beyond the class, escalated and dropped differ in content (the detail text, the hollow mark).
    expect(strip(card("escalated"))).not.toBe(strip(card("validating")));
    expect(strip(card("dropped"))).not.toBe(strip(card("not_done")));
  });
});

describe("engine pages", () => {
  // Markup from graph.js before the `ge-` rename (commit d4b7c38), for the options the run page passes.
  const OLD_CARD =
    '<g class="node s-fixing clickable sel retryable" data-node-id="a" transform="translate(10 20)"><title>A long task title here\nfix pass 1/3</title><rect width="220" height="64" rx="8"></rect><g transform="translate(22 24)"><path class="spin" style="animation-delay: -0ms" d="M0 -5 A5 5 0 1 1 -5 0" fill="none" stroke="var(--c)" stroke-width="2"></path></g><text class="ttl" x="34" y="28">A long task ti…</text><text class="badge warn" x="208" y="28" text-anchor="end">retry</text><text class="meta" x="16" y="49"><tspan class="detail">fix pass 1/3</tspan> · <tspan class="el" data-start="1000">1:05</tspan> · <tspan class="tries">×2</tspan> · <tspan class="resumed reused" data-resumed="reused">reused</tspan></text><text class="meta" x="208" y="49" text-anchor="end"><tspan class="add">+1.2k</tspan><tspan class="del"> −3</tspan></text></g>';
  const OLD_EDGE =
    '<g><path class="edge active ok" d="M0 0 C50 0 50 50 93 50" style="animation-delay: -0ms"></path><path class="arrow active ok" d="M93 46 L100 50 L93 54 Z"></path></g>';
  const renamed = (html: string) =>
    html
      .replace(/class="([^"]*)"/g, (_, c: string) => `class="${c.split(" ").filter(Boolean).map((x) => `ge-${x}`).join(" ")}"`)
      .replace("var(--c)", "var(--ge-c)");

  it("draws the run page's card as before, with only the class names changed", () => {
    const card = renderNodeCard(
      { status: "fixing", attempt: 2, attempts: 3, startedAt: 1000, changes: { total: { added: 1200, deleted: 3, files: 2 } } },
      { id: "a", title: "A long task title here", x: 10, y: 20, provider: "claude", now: 66_000, selected: true, retryable: true, detail: "fix pass 1/3", badge: "retry", badgeClass: "warn", resumed: "reused" },
    );
    expect(card.outerHTML).toBe(renamed(OLD_CARD));
    expect(renderEdge({ x: 0, y: 0 }, { x: 100, y: 50 }, { from: "merged", to: "running" }).outerHTML).toBe(renamed(OLD_EDGE));
  });
});

describe("behaviour", () => {
  it("update() keeps the pan after the user moved, and fits when they did not", () => {
    const host = makeHost();
    const g = mountGraph(host, { tickElapsed: false });
    g.update(diamond());
    const fitted = transform(host);
    // A bigger graph re-fits while the user never moved.
    const bigger = diamond();
    bigger.nodes.push({ id: "e", title: "e", status: "pending" });
    bigger.edges.push({ from: "d", to: "e" });
    g.update(bigger);
    const refitted = transform(host);
    expect(refitted).not.toBe(fitted);
    // Pan, then update: the view stays.
    fire(host, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1, pointerType: "mouse" });
    fire(host, "pointermove", { clientX: 120, clientY: 100, pointerId: 1, pointerType: "mouse" });
    fire(host, "pointerup", { clientX: 120, clientY: 100, pointerId: 1, pointerType: "mouse" });
    const panned = transform(host);
    expect(panned).not.toBe(refitted);
    g.update(diamond());
    expect(transform(host)).toBe(panned);
    // fit() resets, and the next update fits again.
    g.fit();
    expect(transform(host)).toBe(fitted);
    g.update(bigger);
    expect(transform(host)).toBe(refitted);
    g.destroy();
  });

  it("ticks the timers every second, pauses while hidden, and stops on destroy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const host = makeHost();
    const g = mountGraph(host);
    g.update({ nodes: [{ id: "a", title: "a", status: "running", startedAt: 95_000 }], edges: [] });
    const el = () => host.querySelector(".ge-el")!.textContent;
    expect(el()).toBe("0:05");
    vi.advanceTimersByTime(1000);
    expect(el()).toBe("0:06");
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(el()).toBe("0:06");
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(el()).toBe("0:09"); // ticks at once when the tab shows again
    vi.advanceTimersByTime(1000);
    expect(el()).toBe("0:10");
    g.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(host.querySelector(".ge-el")).toBeNull();
  });

  it("tickElapsed: false runs no timer", () => {
    vi.useFakeTimers();
    const g = mountGraph(makeHost(), { tickElapsed: false });
    expect(vi.getTimerCount()).toBe(0);
    g.destroy();
  });

  describe("keyboard", () => {
    const setup = (keyboard?: GraphOptions["keyboard"]) => {
      const input = document.createElement("input");
      document.body.append(input);
      const host = makeHost();
      const g = mountGraph(host, { tickElapsed: false, ...(keyboard === undefined ? {} : { keyboard }) });
      g.update(diamond());
      // Zoom out with the bar so that "f" (fit) has something to undo.
      (host.querySelector('.ge-zoombar button[aria-label="Zoom out"]') as HTMLButtonElement).click();
      return { host, input, g, zoomed: transform(host) };
    };

    it("host (default): only while focus is inside the host, never from an input", () => {
      const { host, input, g, zoomed } = setup();
      expect(host.getAttribute("tabindex")).toBe("0");
      key(input, "f");
      key(document.body, "f");
      key(document.body, "0");
      expect(transform(host)).toBe(zoomed);
      key(host, "f");
      expect(transform(host)).not.toBe(zoomed);
      g.destroy();
      expect(host.hasAttribute("tabindex")).toBe(false);
    });

    it("document: page-wide, but not while typing in an input", () => {
      const { host, input, g, zoomed } = setup("document");
      key(input, "f");
      expect(transform(host)).toBe(zoomed);
      key(document.body, "f");
      expect(transform(host)).not.toBe(zoomed);
      g.destroy();
    });

    it("false: no keyboard handling and no tabindex", () => {
      const { host, g, zoomed } = setup(false);
      expect(host.hasAttribute("tabindex")).toBe(false);
      key(host, "f");
      key(document.body, "f");
      expect(transform(host)).toBe(zoomed);
      g.destroy();
    });
  });

  it("read-only: no selection, no focusable cards, no re-fit on empty space, the zoom bar still works", () => {
    const onSelect = vi.fn();
    const host = makeHost();
    const g = mountGraph(host, { interactive: false, onSelect, tickElapsed: false, selectedId: "a" });
    g.update(diamond());
    const cards = [...host.querySelectorAll("[data-node-id]")];
    expect(cards.every((c) => !c.classList.contains("ge-clickable") && !c.hasAttribute("tabindex"))).toBe(true);
    expect(host.querySelector('[data-node-id="a"]')!.classList.contains("ge-sel")).toBe(true);
    fire(host.querySelector('[data-node-id="b"] rect')!, "click");
    expect(onSelect).not.toHaveBeenCalled();
    (host.querySelector('.ge-zoombar button[aria-label="Zoom in"]') as HTMLButtonElement).click();
    const zoomed = transform(host);
    fire(svgOf(host), "dblclick");
    expect(transform(host)).toBe(zoomed);
    g.destroy();
  });

  it("interactive: clicking a node selects it and calls onSelect", () => {
    const onSelect = vi.fn();
    const host = makeHost();
    const g = mountGraph(host, { onSelect, tickElapsed: false });
    g.update(diamond());
    fire(host.querySelector('[data-node-id="b"] rect')!, "click");
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(host.querySelector('[data-node-id="b"]')!.classList.contains("ge-sel")).toBe(true);
    g.destroy();
  });

  it("mounting and destroying 100 times leaves no listeners, observers, timers or DOM", () => {
    vi.useFakeTimers();
    const live = new Map<string, number>();
    const track = (target: EventTarget, name: string) => {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type, fn, opts) => {
        const signal = typeof opts === "object" && opts ? opts.signal : undefined;
        const id = `${name}:${type}`;
        if (!signal) live.set(id, (live.get(id) ?? 0) + 1);
        else {
          // A listener tied to a signal goes when the signal aborts.
          live.set(id, (live.get(id) ?? 0) + 1);
          signal.addEventListener("abort", () => live.set(id, (live.get(id) ?? 0) - 1));
        }
        add(type, fn, opts);
      });
      vi.spyOn(target, "removeEventListener").mockImplementation((type, fn, opts) => {
        const id = `${name}:${type}`;
        live.set(id, (live.get(id) ?? 0) - 1);
        remove(type, fn, opts);
      });
    };
    const host = makeHost();
    track(document, "document");
    track(window, "window");
    track(host, "host");
    for (let i = 0; i < 100; i++) {
      const g = mountGraph(host, { keyboard: i % 2 ? "document" : "host" });
      g.update(diamond());
      g.destroy();
    }
    for (const [id, n] of live) expect(`${id}=${n}`).toBe(`${id}=0`);
    expect(live.get("document:visibilitychange")).toBe(0);
    expect(FakeResizeObserver.all).toHaveLength(100);
    expect(FakeResizeObserver.all.every((o) => !o.connected)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.childNodes).toHaveLength(0);
    expect([...host.classList].filter((c) => c.startsWith("ge-"))).toEqual([]);
    expect(host.hasAttribute("role") || host.hasAttribute("aria-label") || host.hasAttribute("tabindex")).toBe(false);
  });

  it("destroy is idempotent and later calls do nothing", () => {
    const host = makeHost();
    const g = mountGraph(host);
    g.destroy();
    g.destroy();
    g.update(diamond());
    g.fit();
    expect(host.childNodes).toHaveLength(0);
  });
});
