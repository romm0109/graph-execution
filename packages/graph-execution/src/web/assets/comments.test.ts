import { describe, expect, it } from "vitest";
import { anchor, groupComments, openCountByFile, rangeFrom, rangeText, snippetFor, threadsByRow } from "./comments.js";

type Kind = "add" | "del" | "ctx";
const row = (kind: Kind, old: number | null, nw: number | null, text = "x", hunk = 0, file = "a.ts") => ({ kind, old, new: nw, hunk, file, text });

describe("rangeFrom", () => {
  const rows = [row("ctx", 1, 1), row("add", null, 2), row("ctx", 2, 3), row("ctx", 10, 11, "y", 1), row("ctx", 11, 12, "y", 1), row("ctx", 1, 1, "z", 0, "b.ts")];
  it("spans anchor to focus inclusive", () => expect(rangeFrom(rows, 0, 2)).toEqual([0, 2]));
  it("works with reversed anchor and focus", () => expect(rangeFrom(rows, 2, 0)).toEqual([0, 2]));
  it("clips at the hunk boundary", () => {
    expect(rangeFrom(rows, 1, 4)).toEqual([1, 2]);
    expect(rangeFrom(rows, 4, 0)).toEqual([3, 4]);
  });
  it("clips at the file boundary", () => expect(rangeFrom(rows, 4, 5)).toEqual([4, 4]));
});

describe("anchor", () => {
  it("anchors all-deleted rows to the old side", () => expect(anchor([row("del", 40, null), row("del", 41, null)])).toEqual({ side: "old", startLine: 40, endLine: 41 }));
  it("uses the first and last non-del new numbers when mixed", () =>
    expect(anchor([row("del", 5, null), row("add", null, 5), row("ctx", 6, 6), row("del", 7, null)])).toEqual({ side: "new", startLine: 5, endLine: 6 }));
  it("handles a single context row", () => expect(anchor([row("ctx", 3, 4)])).toEqual({ side: "new", startLine: 4, endLine: 4 }));
  it("honours a forced side", () => expect(anchor([row("ctx", 3, 4), row("ctx", 4, 5)], { side: "old" })).toEqual({ side: "old", startLine: 3, endLine: 4 }));
});

describe("snippetFor", () => {
  it("joins plain rows", () => expect(snippetFor([row("ctx", 1, 1, "a"), row("ctx", 2, 2, "b")])).toBe("a\nb"));
  it("prefixes add and del rows when mixed", () => expect(snippetFor([row("del", 1, null, "a"), row("add", null, 1, "b"), row("ctx", 2, 2, "c")])).toBe("-a\n+b\nc"));
  it("does not prefix a uniform range", () => expect(snippetFor([row("add", null, 1, "a")])).toBe("a"));
  it("caps at 2000 characters", () => {
    const s = snippetFor([row("ctx", 1, 1, "x".repeat(5000))]);
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s.endsWith("\n… (cut)")).toBe(true);
  });
});

describe("rangeText", () => {
  it("formats ranges and single lines", () => {
    expect(rangeText({ side: "new", startLine: 12, endLine: 18 })).toBe("lines +12 to +18");
    expect(rangeText({ side: "old", startLine: 40, endLine: 40 })).toBe("line −40");
    expect(rangeText({ side: "new", startLine: 3, endLine: 3 })).toBe("line +3");
  });
});

describe("threadsByRow", () => {
  const c = (id: string, file: string | undefined, side?: "new" | "old", endLine?: number) => ({ id, file, side, endLine });
  const comments = [c("a", "f.ts", "new", 18), c("b", "f.ts", "old", 42), c("c", "f.ts"), c("d", undefined), c("e", "f.ts", "new", 18), c("g", "other.ts", "new", 1)];
  it("groups by side and end line, file comments under file", () => {
    const t = threadsByRow(comments, "f.ts");
    expect(Object.keys(t).sort()).toEqual(["file", "new:18", "old:42"]);
    expect(t["new:18"]?.map((x) => x.id)).toEqual(["a", "e"]);
    expect(t["old:42"]?.map((x) => x.id)).toEqual(["b"]);
    expect(t.file?.map((x) => x.id)).toEqual(["c"]);
  });
  it("skips general comments and other files", () => {
    expect(threadsByRow(comments, "none.ts")).toEqual({});
  });
});

describe("groupComments", () => {
  const cs = [
    { id: "H1-1", round: 1, file: "b.ts", status: "open" },
    { id: "H1-2", round: 1, file: "a.ts", status: "resolved" },
    { id: "H1-3", round: 1, status: "open" },
    { id: "H2-1", round: 2, file: "a.ts", status: "open" },
  ];
  it("orders rounds newest first and files alphabetically with general last", () => {
    const g = groupComments(cs, { filter: "all" });
    expect(g.map((r) => r.round)).toEqual([2, 1]);
    expect(g[1]!.files.map((f) => f.file)).toEqual(["a.ts", "b.ts", null]);
  });
  it("defaults to open comments", () => expect(groupComments(cs).flatMap((r) => r.files.flatMap((f) => f.comments.map((c) => c.id)))).toEqual(["H2-1", "H1-1", "H1-3"]));
  it("filters resolved", () => expect(groupComments(cs, { filter: "resolved" })).toEqual([{ round: 1, files: [{ file: "a.ts", comments: [cs[1]] }] }]));
  it("limits to one round", () => expect(groupComments(cs, { filter: "all", round: 2 }).map((r) => r.round)).toEqual([2]));
  it("returns nothing for no matches", () => expect(groupComments([], { filter: "all" })).toEqual([]));
});

describe("openCountByFile", () => {
  it("counts open comments of that round per file", () => {
    const m = openCountByFile(
      [
        { round: 1, file: "a.ts", status: "open" },
        { round: 1, file: "a.ts" },
        { round: 1, file: "a.ts", status: "resolved" },
        { round: 1 },
        { round: 2, file: "a.ts", status: "open" },
      ],
      1,
    );
    expect([...m]).toEqual([["a.ts", 2]]);
  });
});
