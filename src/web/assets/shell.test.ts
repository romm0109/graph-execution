import { describe, expect, it } from "vitest";
import { phaseStates, progressText, visiblePhases } from "./shell.js";

describe("visiblePhases", () => {
  const all = ["tasks", "validate", "review", "fix", "human", "done"];
  it("keeps every phase with human review", () => {
    expect(visiblePhases(all, true)).toEqual(all);
  });
  it("drops only human without human review", () => {
    expect(visiblePhases(all, false)).toEqual(["tasks", "validate", "review", "fix", "done"]);
  });
  it("returns the list unchanged when it has no human", () => {
    expect(visiblePhases(["tasks", "done"], false)).toEqual(["tasks", "done"]);
  });
  it("does not mutate its input", () => {
    const input = [...all];
    visiblePhases(input, false);
    visiblePhases(input, true).push("x");
    expect(input).toEqual(all);
  });
});

describe("progressText", () => {
  it("formats done over total", () => {
    expect(progressText(7, 12)).toBe("7/12");
    expect(progressText(0, 0)).toBe("0/0");
  });
});

describe("phaseStates", () => {
  it("marks earlier phases done, the current one, then later ones", () => {
    expect(phaseStates(5, 2, false)).toEqual(["done", "done", "current", "later", "later"]);
  });
  it("marks everything done when finished", () => {
    expect(phaseStates(3, 2, true)).toEqual(["done", "done", "done"]);
  });
});
