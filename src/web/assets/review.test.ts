import { describe, expect, it } from "vitest";
import { decisionLabels, openCount, reviewApi } from "./review.js";

describe("reviewApi", () => {
  it("builds the run page urls", () => {
    const a = reviewApi("");
    expect(a.review).toBe("/review");
    expect(a.diff("a b.ts", 2)).toBe("/review/diff?file=a%20b.ts&round=2");
    expect(a.comment("c/1")).toBe("/review/comments/c%2F1");
    expect(a.decide("apply")).toBe("/review/apply");
    expect(a.lines(1, "x.ts", 3, 9)).toBe("/file?round=1&path=x.ts&from=3&to=9");
  });
  it("prefixes the suite page urls", () => {
    const a = reviewApi("/api");
    expect(a.comments).toBe("/api/review/comments");
    expect(a.lines(1, "x.ts", 3, 9)).toBe("/api/file?round=1&path=x.ts&from=3&to=9");
  });
});

describe("openCount", () => {
  it("counts unresolved comments of the round only", () => {
    const cs = [{ round: 2, status: "open" }, { round: 2, status: "resolved" }, { round: 1, status: "open" }, { round: 2, status: "reopened" }];
    expect(openCount(cs, 2)).toBe(2);
    expect(openCount([], 1)).toBe(0);
  });
});

describe("decisionLabels", () => {
  it("disables Request changes without open comments", () => {
    expect(decisionLabels({ blocking: 0, open: 0 })).toEqual({ apply: "Apply", changes: "Request changes", changesDisabled: true });
  });
  it("counts open comments and says Apply anyway with blockers", () => {
    expect(decisionLabels({ blocking: 1, open: 2 })).toEqual({ apply: "Apply anyway", changes: "Request changes (2)", changesDisabled: false });
  });
  it("accepts another apply label", () => {
    expect(decisionLabels({ blocking: 0, open: 0, applyLabel: "Finish" }).apply).toBe("Finish");
  });
});
