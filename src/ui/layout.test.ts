import { describe, expect, it } from "vitest";
import { glyph, type Layout, layoutGraph } from "./layout.js";

/** The layout as text: edges as box-drawing characters, nodes as their id's first letter. */
function draw(layout: Layout, width: number, height: number): string {
  const grid = Array.from({ length: layout.height }, () => Array<string>(layout.width).fill(" "));
  for (const s of layout.strokes) grid[s.y]![s.x] = glyph(s);
  for (const n of layout.nodes) {
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) grid[n.y + dy]![n.x + dx] = n.id[0]!;
  }
  return grid.map((row) => row.join("").trimEnd()).join("\n");
}

const opts = { nodeWidth: 3, nodeHeight: 1, gap: 1 };

describe("layoutGraph", () => {
  it("draws the diamond top down: a fan-out, a fan-in and an arrow into every child", () => {
    const layout = layoutGraph({ ...opts, layers: [["1"], ["2", "3"], ["4"]], parents: { 2: ["1"], 3: ["1"], 4: ["2", "3"] } });
    expect(draw(layout, 3, 1)).toBe(
      ["  111", " ╭─┴─╮", " ▼   ▼", "222 333", " ╰─┬─╯", "   ▼", "  444"].join("\n"),
    );
  });

  it("routes an edge that skips a layer around the row in between", () => {
    const layout = layoutGraph({ ...opts, layers: [["a"], ["b"], ["c"]], parents: { b: ["a"], c: ["a", "b"] } });
    const text = draw(layout, 3, 1);
    // The long edge a → c passes the row of b as a vertical line, and joins b's edge into c.
    expect(text.split("\n")[3]).toMatch(/bbb +│/);
    expect(layout.strokes.filter((s) => s.arrow)).toHaveLength(2);
  });

  it("reorders a row to avoid crossings", () => {
    const layout = layoutGraph({ ...opts, layers: [["a", "b"], ["c", "d"]], parents: { c: ["b"], d: ["a"] } });
    expect(draw(layout, 3, 1)).toBe(["aaa bbb", " ▼   ▼", "ddd ccc"].join("\n"));
  });

  it("stacks bundles whose spans overlap on separate tracks", () => {
    const parents = { c: ["a", "b"], d: ["a", "b"] };
    const layout = layoutGraph({ ...opts, layers: [["a", "b"], ["c", "d"]], parents });
    // Two fan-ins over the same columns: one track each, then the arrow row.
    expect(layout.height).toBe(1 + 2 + 1 + 1);
    expect(layout.strokes.filter((s) => s.arrow)).toHaveLength(2);
  });

  it("drops straight down without a track when parent and child line up", () => {
    const layout = layoutGraph({ ...opts, layers: [["a"], ["b"]], parents: { b: ["a"] } });
    expect(layout.height).toBe(3);
    expect(draw(layout, 3, 1)).toBe(["aaa", " ▼", "bbb"].join("\n"));
  });
});
