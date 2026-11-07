import { describe, expect, it } from "vitest";
import { formatElapsed, taskProgress } from "./runs";

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(48_000)).toBe("48s");
    expect(formatElapsed(130_000)).toBe("2m10s");
    expect(formatElapsed(65_000)).toBe("1m05s");
    expect(formatElapsed(3_720_000)).toBe("1h02m");
    expect(formatElapsed(0)).toBe("0s");
  });

  it("shows a dash for an unknown or negative duration", () => {
    expect(formatElapsed(undefined)).toBe("—");
    expect(formatElapsed(-1)).toBe("—");
    expect(formatElapsed(Number.NaN)).toBe("—");
  });
});

describe("taskProgress", () => {
  it("counts merged over all tasks", () => {
    expect(taskProgress({ merged: 4, running: 1, pending: 2 })).toBe("4/7");
    expect(taskProgress(undefined)).toBe("");
  });
});
