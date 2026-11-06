import { describe, expect, it } from "vitest";
import hljs from "./vendor/highlight/highlight.min.js";
import typescript from "./vendor/highlight/languages/typescript.min.js";
import { expand, fileStatus, gaps, highlightHunk, highlightLines, langOf, toSplitRows } from "./diffview.js";

hljs.registerLanguage("typescript", typescript);

type L = { kind: "add" | "del" | "ctx"; text: string; old?: number; new?: number };
const hunk = (lines: L[]) => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: "", lines });
const add = (t: string): L => ({ kind: "add", text: t });
const del = (t: string): L => ({ kind: "del", text: t });
const ctx = (t: string): L => ({ kind: "ctx", text: t });

describe("toSplitRows", () => {
  it("puts a pure addition on the right", () => {
    expect(toSplitRows(hunk([add("a"), add("b")]))).toEqual([{ right: add("a") }, { right: add("b") }]);
  });
  it("puts a pure deletion on the left", () => {
    expect(toSplitRows(hunk([del("a")]))).toEqual([{ left: del("a") }]);
  });
  it("zips a deletion run with the following addition run and leaves blanks on the shorter side", () => {
    const rows = toSplitRows(hunk([del("d1"), del("d2"), del("d3"), add("a1")]));
    expect(rows).toEqual([{ left: del("d1"), right: add("a1") }, { left: del("d2") }, { left: del("d3") }]);
    const rows2 = toSplitRows(hunk([del("d1"), add("a1"), add("a2")]));
    expect(rows2).toEqual([{ left: del("d1"), right: add("a1") }, { right: add("a2") }]);
  });
  it("shows context on both sides and keeps runs apart", () => {
    const c = ctx("same");
    const rows = toSplitRows(hunk([del("x"), add("y"), c, add("z")]));
    expect(rows).toEqual([{ left: del("x"), right: add("y") }, { left: c, right: c }, { right: add("z") }]);
  });
});

describe("highlightLines", () => {
  it("keeps the comment class on every line of a block comment", () => {
    const lines = highlightLines(hljs, "/* one\n two\n three */\nconst x = 1;", "typescript");
    expect(lines).toHaveLength(4);
    for (const l of lines.slice(0, 3)) expect(l).toContain("hljs-comment");
    expect(lines[0]).toMatch(/<\/span>$/);
    expect(lines[3]).toContain("hljs-keyword");
  });
  it("keeps the line count and escapes <", () => {
    const text = "if (a < b) {\n  x();\n}\n";
    const lines = highlightLines(hljs, text, "typescript");
    expect(lines).toHaveLength(text.split("\n").length);
    expect(lines[0]).toContain("&lt;");
    expect(lines[0]).not.toMatch(/<\s*b/);
  });
  it("highlights a hunk's sides as a whole and aligns with its lines", () => {
    const h = hunk([ctx("/* start"), del("old */"), add("new */"), ctx("let a = 1;")]);
    const html = highlightHunk(hljs, h, "typescript");
    expect(html).toHaveLength(4);
    expect(html[1]).toContain("hljs-comment");
    expect(html[2]).toContain("hljs-comment");
  });
});

describe("langOf", () => {
  it.each([
    ["src/a.ts", "typescript"], ["a.tsx", "typescript"], ["x.py", "python"], ["a/b.json", "json"], ["s.css", "css"],
    ["README.md", "markdown"], ["main.go", "go"], ["lib.rs", "rust"], ["a.yml", "yaml"], ["run.sh", "bash"], ["index.html", "xml"],
  ])("%s → %s", (path, lang) => expect(langOf(path)).toBe(lang));
  it("returns null for unknown files", () => {
    expect(langOf("a.xyz")).toBeNull();
    expect(langOf("Makefile")).toBeNull();
  });
});

describe("fileStatus", () => {
  it("maps changed files to a status letter", () => {
    expect(fileStatus({ isNew: true })).toBe("A");
    expect(fileStatus({ isDeleted: true })).toBe("D");
    expect(fileStatus({})).toBe("M");
    expect(fileStatus({ oldPath: "a" })).toBe("R");
  });
});

describe("gaps and expand", () => {
  const ctx = (o: number, n: number, text = `l${n}`) => ({ kind: "ctx" as const, old: o, new: n, text });
  // old 1..: a hunk at new 10..12 (old 8..10: two lines were added before it) and one at new 40..41 (old 38..39).
  const h1 = { oldStart: 8, oldLines: 3, newStart: 10, newLines: 3, header: "", lines: [ctx(8, 10), ctx(9, 11), ctx(10, 12)] };
  const h2 = { oldStart: 38, oldLines: 2, newStart: 40, newLines: 2, header: "", lines: [ctx(38, 40), ctx(39, 41)] };
  const text = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `l${a + i}`);

  it("lists the gaps; a first hunk at line 1 has no top gap and total closes the last", () => {
    expect(gaps([h1, h2])).toEqual([{ beforeHunk: 0, from: 1, to: 9 }, { beforeHunk: 1, from: 13, to: 39 }, { beforeHunk: 2, from: 42, to: Infinity }]);
    expect(gaps([h1, h2], 50).at(-1)).toEqual({ beforeHunk: 2, from: 42, to: 50 });
    expect(gaps([h1, h2], 41)).toHaveLength(2);
    expect(gaps([{ ...h1, oldStart: 1, newStart: 1 }], 3)).toEqual([]);
  });

  it("expands up and down with old numbers shifted by the neighbouring hunk", () => {
    const up = expand([h1, h2], 20, text(20, 39));
    expect(up).toHaveLength(2);
    expect(up[1]!.newStart).toBe(20);
    expect(up[1]!.lines[0]).toEqual({ kind: "ctx", old: 18, new: 20, text: "l20" });
    expect(up[1]!.lines[19]).toMatchObject({ old: 37, new: 39 });
    expect(up[1]!.lines[20]).toMatchObject({ old: 38, new: 40 });
    const down = expand([h1, h2], 13, text(13, 17));
    expect(down[0]!.lines).toHaveLength(8);
    expect(down[0]!.lines[3]).toMatchObject({ old: 11, new: 13 });
    const below = expand([h1, h2], 42, text(42, 44));
    expect(below[1]!.lines.at(-1)).toMatchObject({ old: 42, new: 44 });
    expect(below[1]!.newLines).toBe(5);
  });

  it("merges the hunks when the gap closes, without changing its input", () => {
    const merged = expand([h1, h2], 13, text(13, 39));
    expect(merged).toHaveLength(1);
    const m = merged[0]!;
    expect(m).toMatchObject({ oldStart: 8, newStart: 10, oldLines: 32, newLines: 32 });
    expect(m.lines.map((l) => l.new)).toEqual(Array.from({ length: 32 }, (_, i) => 10 + i));
    expect(m.lines.find((l) => l.new === 40)).toMatchObject({ old: 38 });
    expect(gaps(merged, 41)).toEqual([{ beforeHunk: 0, from: 1, to: 9 }]);
    expect(h1.lines).toHaveLength(3);
    expect(expand([h1], 5, [])).toEqual([h1]);
  });
});
