import { describe, expect, it } from "vitest";
import type { NodeStatus } from "../../ui/store.js";
import { MAX_K, MIN_K, edgeClass, edgePath, formatElapsed, layoutLayers, nodeClass, pinchView } from "./graph.js";

const layers = [["1"], ["2", "3"], ["4"]];
const parents = { "2": ["1"], "3": ["1"], "4": ["2", "3"] };
const opts = { nodeW: 100, nodeH: 40, gapX: 20, gapY: 10, pad: 8 };

describe("layoutLayers", () => {
  const out = layoutLayers(layers, parents, opts);

  it("puts the diamond in 3 columns", () => {
    const xs = ["1", "2", "3", "4"].map((id) => out.nodes.get(id)!.x);
    expect(xs).toEqual([8, 128, 128, 248]);
    expect(out.nodes.get("2")!.y).not.toBe(out.nodes.get("3")!.y);
  });

  it("centres the nodes of a layer vertically", () => {
    // the tallest layer has 2 nodes: 40 + 10 + 40 = 90 inner height
    expect(out.nodes.get("2")!.y).toBe(8);
    expect(out.nodes.get("3")!.y).toBe(58);
    expect(out.nodes.get("1")!.y).toBe(8 + (90 - 40) / 2);
    expect(out.nodes.get("4")!.y).toBe(out.nodes.get("1")!.y);
  });

  it("includes the padding in width and height", () => {
    expect(out.width).toBe(8 * 2 + 3 * 100 + 2 * 20);
    expect(out.height).toBe(8 * 2 + 90);
  });

  it("has one edge per parent link, from the right of the parent to the left of the child", () => {
    expect(out.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["1>2", "1>3", "2>4", "3>4"]);
    const e = out.edges.find((x) => x.from === "1" && x.to === "2")!;
    expect(e.points[0]).toEqual({ x: 108, y: out.nodes.get("1")!.y + 20 });
    expect(e.points[1]).toEqual({ x: 128, y: 8 + 20 });
  });

  it("ignores parents that are not laid out and handles no layers", () => {
    expect(layoutLayers([["a"]], { a: ["gone"] }, opts).edges).toEqual([]);
    const empty = layoutLayers([], {}, opts);
    expect(empty.nodes.size).toBe(0);
    expect(empty.width).toBe(16);
  });
});

describe("edgePath", () => {
  it("is a bezier that stops short of the target for the arrow", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 50 })).toBe("M0 0 C50 0 50 50 93 50");
    expect(edgePath({ x: 0, y: 0 }, { x: 40, y: 100 }, true)).toBe("M0 0 C0 50 40 50 40 93");
  });
});

describe("edgeClass", () => {
  it("animates edges into running nodes and dims edges out of failed ones", () => {
    expect(edgeClass("merged", "running")).toBe("ge-active ge-ok");
    expect(edgeClass("failed", "pending")).toBe("ge-dim");
    expect(edgeClass("pending", "pending")).toBe("");
  });
});

describe("nodeClass", () => {
  it("maps every NodeStatus to ge-node ge-s-<status>", () => {
    const all: NodeStatus[] = ["pending", "running", "validating", "fixing", "merging", "merged", "done", "failed", "skipped", "escalated"];
    for (const s of all) expect(nodeClass(s)).toBe(`ge-node ge-s-${s}`);
  });
});

describe("formatElapsed", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(83_000)).toBe("1:23");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("pinchView", () => {
  it("spreads around a fixed midpoint", () => {
    const v = pinchView({ x: 0, y: 0, k: 1 }, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 50, y: 100 }, { x: 250, y: 100 }]);
    expect(v).toEqual({ x: -150, y: -100, k: 2 });
  });

  it("pans with two fingers at the same distance", () => {
    const v = pinchView({ x: 5, y: 5, k: 1 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 20, y: 10 }, { x: 120, y: 10 }]);
    expect(v).toEqual({ x: 25, y: 15, k: 1 });
  });

  it("clamps the scale to MIN_K … MAX_K", () => {
    expect(MIN_K).toBe(0.15);
    expect(MAX_K).toBe(2.5);
    const spread = pinchView({ x: 0, y: 0, k: 1 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(spread.k).toBe(MAX_K);
    const squeeze = pinchView({ x: 0, y: 0, k: 0.5 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(squeeze.k).toBe(MIN_K);
  });

  it("keeps the midpoint's content point fixed at a non-1 start scale", () => {
    const v = pinchView({ x: 10, y: 20, k: 0.5 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: -50, y: 0 }, { x: 150, y: 0 }]);
    expect(v.k).toBe(1);
    expect((50 - v.x) / v.k).toBe((50 - 10) / 0.5);
    expect(v.x).toBe(-30);
    expect(v.y).toBe(40);
  });

  it("returns a copy of start when the starting fingers are on the same spot", () => {
    const start = { x: 1, y: 2, k: 1.5 };
    const v = pinchView(start, [{ x: 5, y: 5 }, { x: 5, y: 5 }], [{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    expect(v).toEqual(start);
    expect(v).not.toBe(start);
  });
});
