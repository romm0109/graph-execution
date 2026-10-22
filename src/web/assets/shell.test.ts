import { describe, expect, it } from "vitest";
import { phaseStates, progressText } from "./shell.js";

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
