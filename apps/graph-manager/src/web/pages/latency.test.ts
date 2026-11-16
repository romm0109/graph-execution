import { describe, expect, it } from "vitest";
import { latencyTone, medianLatency } from "./TerminalPane";

describe("medianLatency", () => {
  it("keeps one slow sample (a busy moment) out of the readout", () => {
    expect(medianLatency([1, 1, 240, 2, 1])).toBe(1);
  });

  it("follows a lasting change within a few samples", () => {
    expect(medianLatency([1, 1, 150, 150, 150])).toBe(150);
  });

  it("handles a short or empty history", () => {
    expect(medianLatency([])).toBeUndefined();
    expect(medianLatency([30])).toBe(30);
    expect(medianLatency([10, 30])).toBe(20);
  });
});

describe("latencyTone", () => {
  it("is green under 80 ms, amber under 200 ms, red above", () => {
    expect(latencyTone(1)).toBe("ok");
    expect(latencyTone(120)).toBe("warn");
    expect(latencyTone(300)).toBe("bad");
  });
});
