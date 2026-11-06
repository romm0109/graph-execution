import { describe, expect, it } from "vitest";
import { parseFileDiff, parseUnifiedDiff } from "./diff.js";

const modified = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -40,2 +40,3 @@ function foo() {
 x
+y
 z
`;

describe("parseFileDiff", () => {
  it("numbers lines in a file with two hunks", () => {
    const f = parseFileDiff("src/a.ts", modified);
    expect(f.status).toBe("M");
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0]!.lines).toEqual([
      { kind: "ctx", old: 1, new: 1, text: "one" },
      { kind: "del", old: 2, text: "two" },
      { kind: "add", new: 2, text: "TWO" },
      { kind: "ctx", old: 3, new: 3, text: "three" },
    ]);
    expect(f.hunks[1]!.lines.map((l) => [l.old, l.new])).toEqual([[40, 40], [undefined, 41], [41, 42]]);
  });

  it("keeps the function context of a hunk header", () => {
    const f = parseFileDiff("src/a.ts", modified);
    expect(f.hunks[0]!.header).toBe("");
    expect(f.hunks[1]!.header).toBe("function foo() {");
    expect(f.hunks[1]).toMatchObject({ oldStart: 40, oldLines: 2, newStart: 40, newLines: 3 });
  });

  it("parses a new file", () => {
    const f = parseFileDiff("n.txt", "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n");
    expect(f.status).toBe("A");
    expect(f.hunks[0]!.lines.map((l) => l.new)).toEqual([1, 2, 3]);
  });

  it("parses a deleted file", () => {
    const f = parseFileDiff("d.txt", "--- a/d.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n");
    expect(f.status).toBe("D");
    expect(f.hunks[0]!.lines.map((l) => l.old)).toEqual([1, 2]);
  });

  it("skips the no-newline marker", () => {
    const f = parseFileDiff("a", "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n");
    expect(f.hunks[0]!.lines).toHaveLength(2);
  });

  it("handles CRLF", () => {
    const f = parseFileDiff("a", "@@ -1,2 +1,2 @@ ctx\r\n a\r\n-b\r\n+c\r\n");
    expect(f.hunks[0]!.header).toBe("ctx");
    expect(f.hunks[0]!.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("returns no hunks for an empty diff", () => {
    expect(parseFileDiff("a", "").hunks).toEqual([]);
    expect(parseUnifiedDiff("").files).toEqual([]);
  });

  it("flags binary files", () => {
    expect(parseFileDiff("a", "Binary files a/a and b/a differ\n").binary).toBe(true);
  });
});

describe("parseUnifiedDiff", () => {
  it("splits files and detects renames", () => {
    const text = modified + `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 1..2 100644
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`;
    const { files } = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "new.ts"]);
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[1]).toMatchObject({ status: "R", oldPath: "old.ts" });
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });
});
