import { describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { graphModel } from "./model.js";
import { RunStore } from "./store.js";

const model = (reviewers?: { id: string; name: string }[]) => {
  const store = new RunStore(new RunEmitter(), {
    taskIds: ["a"],
    attempts: 3,
    ...(reviewers ? { reviewers, customReviewers: true } : {}),
  });
  return graphModel({ layers: [["a"]], parents: {}, state: store.getState() });
};

describe("graphModel", () => {
  it("draws the built-in reviewers as today without a reviewers file", () => {
    const m = model();
    expect(m.layers).toEqual([["a"], ["@gate"], ["@reviewer", "@tester"], ["@fixer"], ["@merge"]]);
    expect(m.nodes.get("@reviewer")?.title).toBe("code reviewer");
    expect(m.nodes.get("@tester")?.title).toBe("live tester");
    expect(m.parents["@fixer"]).toEqual(["@reviewer", "@tester"]);
  });

  it("puts every enabled reviewer in the reviewers' layer, above the fixer", () => {
    const m = model([
      { id: "code", name: "Code review" },
      { id: "tester", name: "Live test" },
      { id: "security", name: "Security" },
    ]);
    expect(m.layers).toEqual([["a"], ["@gate"], ["@reviewer", "@tester", "@security"], ["@fixer"], ["@merge"]]);
    expect(m.nodes.get("@security")?.title).toBe("Security");
    expect(m.nodes.get("@reviewer")?.title).toBe("Code review");
    expect(m.parents["@security"]).toEqual(["@gate"]);
    expect(m.parents["@fixer"]).toEqual(["@reviewer", "@tester", "@security"]);
  });

  it("hangs the fixer below the gate when no reviewer is enabled", () => {
    const m = model([]);
    expect(m.layers).toEqual([["a"], ["@gate"], ["@fixer"], ["@merge"]]);
    expect(m.nodes.has("@reviewer")).toBe(false);
    expect(m.nodes.has("@tester")).toBe(false);
    expect(m.parents["@fixer"]).toEqual(["@gate"]);
  });
});
