import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchOutput } from "./output-batch.js";

describe("batchOutput", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a lone chunk at once, so a typed key's echo is not delayed", () => {
    const sent: string[] = [];
    batchOutput((d) => sent.push(d), 6, () => Date.now()).push("a");
    expect(sent).toEqual(["a"]);
  });

  it("joins the chunks of a burst into one frame", () => {
    const sent: string[] = [];
    const b = batchOutput((d) => sent.push(d), 6, () => Date.now());
    b.push("1");
    b.push("2");
    b.push("3");
    expect(sent).toEqual(["1"]);
    vi.advanceTimersByTime(6);
    expect(sent).toEqual(["1", "23"]);
    // Quiet for a window: the next chunk goes straight out again.
    vi.advanceTimersByTime(6);
    b.push("4");
    expect(sent).toEqual(["1", "23", "4"]);
  });

  it("flush sends pending output now and keeps the order", () => {
    const sent: string[] = [];
    const b = batchOutput((d) => sent.push(d), 6, () => Date.now());
    b.push("x");
    b.push("y");
    b.flush();
    sent.push("<exit>");
    vi.advanceTimersByTime(20);
    expect(sent).toEqual(["x", "y", "<exit>"]);
  });

  it("dispose drops pending output and the timer", () => {
    const sent: string[] = [];
    const b = batchOutput((d) => sent.push(d), 6, () => Date.now());
    b.push("x");
    b.push("y");
    b.dispose();
    vi.advanceTimersByTime(20);
    expect(sent).toEqual(["x"]);
  });
});
