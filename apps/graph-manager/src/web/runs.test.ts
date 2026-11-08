import { describe, expect, it } from "vitest";
import { formatElapsed, nextRunWatch, taskProgress, type RunSummary } from "./runs";

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

describe("nextRunWatch", () => {
  const r = (id: string, over: Partial<RunSummary> = {}): RunSummary =>
    ({ workspaceId: "github~o~r", id, type: "run", kind: "live", status: "running", live: true, ...over }) as RunSummary;
  it("takes the first list as the baseline, then reports a new running run once", () => {
    const first = nextRunWatch(undefined, [r("a")]);
    expect(first.started).toEqual([]);
    const second = nextRunWatch(first.watch, [r("a"), r("b")]);
    expect(second.started.map((x) => x.id)).toEqual(["b"]);
    expect(nextRunWatch(second.watch, [r("a"), r("b")]).started).toEqual([]);
  });
  it("reports a new run only once it runs", () => {
    const base = nextRunWatch(undefined, []).watch;
    const pending = nextRunWatch(base, [r("c", { live: false, status: "unknown" })]);
    expect(pending.started).toEqual([]);
    expect(nextRunWatch(pending.watch, [r("c")]).started.map((x) => x.id)).toEqual(["c"]);
  });
});
