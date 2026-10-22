import { describe, expect, it } from "vitest";
import { clampWidth, readPanelState } from "./panel.js";

describe("clampWidth", () => {
  it("clamps to 320 … 85% of the viewport", () => {
    expect(clampWidth(100, 1200)).toBe(320);
    expect(clampWidth(640, 1200)).toBe(640);
    expect(clampWidth(5000, 1200)).toBe(1020);
  });
});

describe("readPanelState", () => {
  it("defaults on bad input", () => {
    const d = { width: 640, open: false, tab: "overview" };
    expect(readPanelState("")).toEqual(d);
    expect(readPanelState("{nope")).toEqual(d);
    expect(readPanelState("null")).toEqual(d);
  });
  it("reads valid fields and ignores wrong types", () => {
    expect(readPanelState('{"width":700,"open":true,"tab":"logs"}')).toEqual({ width: 700, open: true, tab: "logs" });
    expect(readPanelState('{"width":"x","open":1}')).toEqual({ width: 640, open: false, tab: "overview" });
  });
});
