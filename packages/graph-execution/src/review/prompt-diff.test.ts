import { describe, expect, it } from "vitest";
import { codeReviewerPrompt, diffSection, fence } from "../agents/reviewer.js";
import type { ReviewerContext } from "./context.js";
import { groupFiles, groupOf, isGeneratedFile, packGroups, promptDiff, splitDiff } from "./prompt-diff.js";

const fileDiff = (path: string, lines: number, removed = 0): string =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${lines} @@`,
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: lines }, (_, i) => `+line ${i} of ${path}`),
    "",
  ].join("\n");

describe("splitDiff", () => {
  it("splits per file and counts added and removed lines, not the ---/+++ headers", () => {
    const parts = splitDiff(fileDiff("src/a.ts", 3, 2) + fileDiff("src/b.ts", 1));
    expect(parts.map((p) => [p.path, p.added, p.removed])).toEqual([
      ["src/a.ts", 3, 2],
      ["src/b.ts", 1, 0],
    ]);
  });
});

describe("isGeneratedFile", () => {
  it("matches lockfiles, bundles, maps and migration snapshots only", () => {
    for (const f of ["pnpm-lock.yaml", "apps/x/package-lock.json", "go.sum", "dist/app.min.js", "a.js.map", "packages/db/migrations/meta/0001_snapshot.json"]) {
      expect(isGeneratedFile(f), f).toBe(true);
    }
    for (const f of ["src/lock.ts", "packages/db/migrations/0000_init.sql", "snapshot.json"]) expect(isGeneratedFile(f), f).toBe(false);
  });
});

describe("promptDiff", () => {
  it("inlines a diff within budget whole, listing only the generated files", () => {
    const src = fileDiff("src/a.ts", 3) + fileDiff("src/b.ts", 2);
    expect(promptDiff(fileDiff("pnpm-lock.yaml", 50) + src)).toEqual({
      mode: "inline",
      text: src,
      generated: [{ path: "pnpm-lock.yaml", added: 50, removed: 0 }],
    });
  });

  it("inlines nothing past the budget and groups the files by area", () => {
    const diff = fileDiff("apps/server/src/a.ts", 50) + fileDiff("apps/client/b.tsx", 50) + fileDiff("apps/server/c.ts", 1) + fileDiff("README.md", 1);
    const r = promptDiff(diff, 100);
    expect(r.mode).toBe("files");
    if (r.mode !== "files") return;
    expect(r.parts).toEqual([
      {
        folders: ["apps/server", "apps/client", "."],
        files: [
          { path: "apps/server/src/a.ts", added: 50, removed: 0 },
          { path: "apps/server/c.ts", added: 1, removed: 0 },
          { path: "apps/client/b.tsx", added: 50, removed: 0 },
          { path: "README.md", added: 1, removed: 0 },
        ],
      },
    ]);
  });

  it("does not count generated files toward the budget", () => {
    const src = fileDiff("src/a.ts", 2);
    expect(promptDiff(fileDiff("pnpm-lock.yaml", 5000) + src, src.length).mode).toBe("inline");
  });
});

describe("groupFiles", () => {
  const f = (path: string) => ({ path, added: 1, removed: 0 });
  it("splits a group past the limit one folder deeper, and keeps a folder's own files together", () => {
    const files = [f("apps/server/a.ts"), f("apps/server/src/x/b.ts"), f("apps/server/src/y/c.ts"), f("apps/client/d.ts")];
    expect(groupFiles(files, 1).map((g) => [g.name, g.files.length])).toEqual([
      ["apps/server", 1],
      ["apps/server/src/x", 1],
      ["apps/server/src/y", 1],
      ["apps/client", 1],
    ]);
  });

  it("stops when the files cannot be split further", () => {
    expect(groupFiles([f("src/a.ts"), f("src/b.ts"), f("src/c.ts")], 2)).toEqual([{ name: "src", files: [f("src/a.ts"), f("src/b.ts"), f("src/c.ts")] }]);
  });
});

describe("packGroups", () => {
  const g = (name: string, n: number) => ({ name, files: Array.from({ length: n }, (_, i) => ({ path: `${name}/${i}.ts`, added: 1, removed: 0 })) });
  it("packs neighbouring groups up to the limit", () => {
    expect(packGroups([g("a", 3), g("b", 2), g("c", 4), g("d", 1)], 5).map((p) => [p.folders, p.files.length])).toEqual([
      [["a", "b"], 5],
      [["c", "d"], 5],
    ]);
  });
});

describe("groupOf", () => {
  it("uses the first two folders", () => {
    expect([groupOf("apps/server/src/x.ts"), groupOf("src/x.ts"), groupOf("x.ts")]).toEqual(["apps/server", "src", "."]);
  });
});

describe("reviewer prompt of a change set larger than the context window", () => {
  // Regression: a 515-file, 2.86 MB diff made the code reviewer's first request 1.39M tokens (limit 1M).
  const files = Array.from({ length: 515 }, (_, i) => fileDiff(`apps/${i % 2 ? "server" : "client"}/src/f${i}.ts`, 120));
  const diff = fileDiff("pnpm-lock.yaml", 8000) + files.join("");
  const ctx: ReviewerContext = { spec: "# Spec\n", tasksDir: "/tasks", diff, diffBase: "08af7082680727860ec75608b4f60c6f2c7f5590", changedFiles: [] };

  it("includes no diff, lists every file by group and asks for a subagent per group", () => {
    expect(diff.length).toBeGreaterThan(1_500_000);
    const prompt = codeReviewerPrompt(ctx, 0, "/r.json");
    expect(prompt.length).toBeLessThan(100_000);
    expect(prompt).not.toContain("+line 0 of");
    // Both folders hold more than 50 files but cannot be split deeper: one part each.
    expect(prompt).toContain("### Part 1: apps/client (258 files, +30960 -0)");
    expect(prompt).toContain("### Part 2: apps/server (257 files, +30840 -0)");
    expect(prompt).toContain("- apps/server/src/f513.ts (+120 -0)");
    expect(prompt).toContain("`git diff 08af7082680727860ec75608b4f60c6f2c7f5590..HEAD -- <folder> <folder> ...`");
    expect(prompt).toContain("Review the 2 parts below in parallel, one subagent per part");
    expect(prompt).toContain("look for problems BETWEEN parts");
    expect(prompt).toContain("- pnpm-lock.yaml (+8000 -0)");
  });

  it("points at the Repositories section when the base is not a single commit", () => {
    expect(diffSection({ diff }).join("\n")).toContain("`git diff <starting commit>..HEAD -- <file>`");
  });

  it("keeps the empty-diff marker", () => {
    expect(diffSection({ diff: "" })).toEqual(["## Diff against the starting commit", "", "(empty diff)", ""]);
  });

  it("inlines a small diff as before", () => {
    const small = fileDiff("src/a.ts", 2);
    expect(diffSection({ diff: small })).toEqual(["## Diff against the starting commit", "", fence(small), ""]);
  });
});
