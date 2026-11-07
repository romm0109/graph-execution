import { describe, expect, it } from "vitest";
import type { NodeChanges } from "../runner/events.js";
import { graphRows, statsText } from "./Graph.js";
import { RunEmitter } from "../runner/events.js";
import { RunStore } from "./store.js";

const ch = (added: number, deleted: number, files: number): NodeChanges => ({ files: [], total: { added, deleted, files } });

describe("statsText", () => {
  it("is empty without changes", () => {
    expect(statsText(undefined, 40)).toBe("");
    expect(statsText(ch(0, 0, 0), 40)).toBe("");
  });
  it("formats long, singular and k forms", () => {
    expect(statsText(ch(120, 8, 4), 40)).toBe("+120 −8 · 4 files");
    expect(statsText(ch(1, 0, 1), 40)).toBe("+1 −0 · 1 file");
    expect(statsText(ch(1234, 12000, 4), 40)).toBe("+1.2k −12k · 4 files");
  });
  it("shortens to fit", () => {
    expect(statsText(ch(120, 8, 4), 14)).toBe("+120 −8 · 4f");
    expect(statsText(ch(120, 8, 4), 7)).toBe("+120 −8");
    expect(statsText(ch(120, 8, 4), 4).length).toBeLessThanOrEqual(4);
  });
});

describe("graphRows with stats", () => {
  for (const columns of [80, 40]) {
    it(`fits ${columns} columns with 4-row boxes`, () => {
      const events = new RunEmitter();
      const store = new RunStore(events, { taskIds: ["1", "2"], attempts: 3 });
      events.emit("task:start", { taskId: "1" });
      events.emit("nodeChanges", { nodeId: "1", changes: ch(12345, 6789, 321) });
      const { rows } = graphRows({ layers: [["1"], ["2"]], parents: { "2": ["1"] }, state: store.getState(), frame: 0, columns });
      for (const r of rows) expect(r.length).toBeLessThanOrEqual(columns);
      const text = rows.map((r) => r.map((c) => c.ch).join(""));
      if (columns === 80) {
        const top = text.findIndex((l) => l.includes("┏"));
        expect(text.findIndex((l, i) => i > top && l.includes("┗")) - top).toBe(3);
        expect(text.join("\n")).toContain("+12.3k −6.8k");
      } else {
        expect(text.join("\n")).toContain("+12.3k");
      }
    });
  }
});
