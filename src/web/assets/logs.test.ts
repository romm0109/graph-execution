import { describe, expect, it } from "vitest";
import { labelsForNode as labelsTs } from "../logtail.js";
import { filterLines, labelsForNode, mergeTail } from "./logs.js";

describe("labelsForNode", () => {
  const labels = ["3", "3-validate-1", "30", "code-r1", "tester-r2", "fix-r1", "fix-r1-v2", "summary-3", "summary--fixer", "merge"];
  it("maps nodes to their logs, like the server", () => {
    expect(labelsForNode("3", labels)).toEqual(["3", "3-validate-1", "summary-3"]);
    expect(labelsForNode("@reviewer", labels)).toEqual(["code-r1"]);
    expect(labelsForNode("@fixer", labels)).toEqual(["fix-r1", "fix-r1-v2", "summary--fixer"]);
    expect(labelsForNode("@gate-fixer", labels)).toEqual(["fix-r1-v2"]);
    expect(labelsForNode("@merge", labels)).toEqual([]);
    for (const id of ["3", "@reviewer", "@tester", "@fixer", "@gate-fixer", "@gate", "@merge"]) expect(labelsForNode(id, labels)).toEqual(labelsTs(id, labels));
  });
});

describe("mergeTail", () => {
  it("appends and ignores data already seen", () => {
    let s = { offset: 3, text: "abc" };
    s = mergeTail(s, { offset: 3, text: "def" });
    expect(s).toEqual({ offset: 6, text: "abcdef" });
    expect(mergeTail(s, { offset: 3, text: "def" })).toBe(s);
    expect(mergeTail(s, { offset: 4, text: "efgh" })).toEqual({ offset: 8, text: "abcdefgh" });
  });
  it("counts bytes, not characters", () => {
    expect(mergeTail({ offset: 2, text: "é" }, { offset: 0, text: "éx" })).toEqual({ offset: 3, text: "éx" });
  });
});

describe("filterLines", () => {
  it("keeps matching lines, case-insensitively, with the match range", () => {
    expect(filterLines("one\nTwo error\nthree\n", "ERR")).toEqual([{ line: "Two error", match: [4, 7] }]);
  });
  it("returns every line for an empty query", () => {
    expect(filterLines("a\nb\n", "")).toEqual([{ line: "a", match: null }, { line: "b", match: null }]);
  });
});
