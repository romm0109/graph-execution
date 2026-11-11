import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeReviewerPrompt } from "../agents/reviewer.js";
import { testerPrompt } from "../agents/tester.js";
import type { ReviewerContext } from "./context.js";
import {
  applyReviewDefaults,
  BUILTIN_INSTRUCTIONS,
  BUILTIN_REVIEWERS,
  checkGlob,
  loadReviewersFile,
  matchFiles,
  notPerformed,
  parseReviewers,
  readRunReviewers,
  reviewerAgent,
  reviewerNode,
  ReviewersError,
  reviewersFileOf,
  stepName,
} from "./reviewers.js";

const code = { id: "code", type: "diff", name: "Code review", repoFile: "REVIEW.md" };
const tester = { id: "tester", type: "tester", name: "Live test", repoFile: "TESTING.md" };
const security = { id: "security", type: "diff", name: "Security", repoFile: "SECURITY_REVIEW.md" };

const parse = (reviewers: unknown[]) => parseReviewers({ reviewers }, "r.json");
const errorOf = (reviewers: unknown[]): string => {
  try {
    parse(reviewers);
  } catch (err) {
    expect(err).toBeInstanceOf(ReviewersError);
    return (err as Error).message;
  }
  throw new Error("expected the reviewers file to be rejected");
};

describe("reviewers file", () => {
  it("parses a valid file and fills the defaults", () => {
    const list = parse([code, tester, security]);
    expect(list.map((r) => r.id)).toEqual(["code", "tester", "security"]);
    expect(list[2]).toEqual({ ...security, enabled: true, blockAt: "major", instructions: "" });
  });

  it.each<[string, unknown[], string]>([
    ["a duplicate id", [code, { ...security, id: "code" }], 'reviewers.1.id: id: duplicate reviewer id "code"'],
    ["a duplicate repoFile", [code, { ...security, repoFile: "review.md" }], 'reviewers.1.repoFile: repoFile: "review.md" is already used by reviewer "code"'],
    ["a repoFile outside the root", [{ ...security, repoFile: "../x.md" }], "reviewers.0.repoFile: repoFile: must be a .md file name at the repo root"],
    ["a repoFile in a folder", [{ ...security, repoFile: "a/b.md" }], "reviewers.0.repoFile: repoFile: must be a .md file name"],
    ["a repoFile that is not .md", [{ ...security, repoFile: "x.txt" }], "reviewers.0.repoFile: repoFile: must be a .md file name"],
    ["a second tester", [tester, { ...security, id: "qa", type: "tester" }], 'reviewers.1.type: type: only the reviewer with id "tester" can have type "tester"'],
    ["a tester of type diff", [{ ...tester, type: "diff" }], 'reviewers.0.type: type: the reviewer "tester" must have type "tester"'],
    ["an upper-case id", [{ ...security, id: "Security" }], "reviewers.0.id: id: use lowercase letters"],
    ["an id starting with a hyphen", [{ ...security, id: "-x" }], "reviewers.0.id: id: use lowercase letters"],
    ["an id of 33 chars", [{ ...security, id: "a".repeat(33) }], "reviewers.0.id:"],
    ["a reserved id", [{ ...security, id: "fixer" }], "reviewers.0.id: id: this id is reserved"],
    ["an unknown key", [{ ...security, color: "red" }], "reviewers.0"],
    ["an unknown provider", [{ ...security, provider: "gpt" }], "reviewers.0.provider:"],
    ["a glob with brackets", [{ ...security, files: ["src/[ab].ts"] }], 'reviewers.0.files.0: invalid glob "src/[ab].ts"'],
    ["an absolute glob", [{ ...security, files: ["/abs/**"] }], 'reviewers.0.files.0: invalid glob "/abs/**"'],
    ["a glob with ..", [{ ...security, files: ["../x"] }], 'reviewers.0.files.0: invalid glob "../x"'],
    ["an empty negated glob", [{ ...security, files: ["!"] }], 'reviewers.0.files.0: invalid glob "!"'],
    ["a name of 61 chars", [{ ...security, name: "n".repeat(61) }], "reviewers.0.name:"],
    ["instructions over 20 000 chars", [{ ...security, instructions: "i".repeat(20_001) }], "reviewers.0.instructions:"],
  ])("rejects %s", (_, reviewers, message) => {
    const error = errorOf(reviewers);
    expect(error).toMatch(/^invalid reviewers file r\.json:\n/);
    expect(error).toContain(message);
  });

  it("checks globs", () => {
    expect(checkGlob("src/**")).toBeUndefined();
    expect(checkGlob("!**/*.test.ts")).toBeUndefined();
    expect(checkGlob("src/{a,b}.ts")).toMatch(/^invalid glob "src\/\{a,b\}\.ts": /);
  });
});

describe("matchFiles", () => {
  const files = ["src/a.ts", "src/a.test.ts", "docs/x.md"];
  it("keeps the files of a positive glob and drops the negated ones", () => {
    expect(matchFiles(files, ["src/**", "!**/*.test.ts"])).toEqual(["src/a.ts"]);
    expect(matchFiles(files, ["**/*.md"])).toEqual(["docs/x.md"]);
    expect(matchFiles(files, ["!docs/**"])).toEqual(["src/a.ts", "src/a.test.ts"]);
    expect(matchFiles(files, ["src/?.ts"])).toEqual(["src/a.ts"]);
  });
  it("keeps every file without globs", () => {
    expect(matchFiles(files, undefined)).toEqual(files);
    expect(matchFiles(files, [])).toEqual(files);
  });
  it("does not match across directories with a single star", () => {
    expect(matchFiles(files, ["*.ts"])).toEqual([]);
  });
});

describe("loadReviewersFile", () => {
  it("names the path of a missing file or bad JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "reviewers-"));
    try {
      const missing = path.join(dir, "nope.json");
      await expect(loadReviewersFile(missing)).rejects.toThrow(new ReviewersError(`reviewers file not found: ${missing}`));
      const bad = path.join(dir, "bad.json");
      await writeFile(bad, "{ nope");
      await expect(loadReviewersFile(bad)).rejects.toThrow(`invalid JSON in reviewers file ${bad}: `);
      await expect(loadReviewersFile(bad)).rejects.toBeInstanceOf(ReviewersError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is read from the run dir, enabled reviewers only, and the built-ins without a copy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "reviewers-"));
    try {
      expect(await readRunReviewers(dir)).toEqual(BUILTIN_REVIEWERS);
      await writeFile(path.join(dir, "reviewers.json"), JSON.stringify({ reviewers: [code, { ...tester, enabled: false }, security] }));
      expect((await readRunReviewers(dir)).map((r) => r.id)).toEqual(["code", "security"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("picks the flag over the env var, and an empty env var counts as unset", () => {
    expect(reviewersFileOf("a.json", { GRAPH_EXECUTION_REVIEWERS: "b.json" })).toBe("a.json");
    expect(reviewersFileOf(undefined, { GRAPH_EXECUTION_REVIEWERS: "b.json" })).toBe("b.json");
    expect(reviewersFileOf(undefined, { GRAPH_EXECUTION_REVIEWERS: "" })).toBeUndefined();
    expect(reviewersFileOf(undefined, {})).toBeUndefined();
  });

  it("keeps the built-in names", () => {
    expect(stepName({ id: "code", name: "Code review" })).toBe("code review");
    expect(notPerformed({ id: "tester", name: "Live test" })).toBe("live test not performed");
    expect(notPerformed({ id: "security", name: "Security" })).toBe("Security not performed");
    expect([reviewerAgent("code"), reviewerAgent("tester"), reviewerAgent("security")]).toEqual(["reviewer", "tester", "security"]);
    expect([reviewerNode("code"), reviewerNode("tester"), reviewerNode("security")]).toEqual(["@reviewer", "@tester", "@security"]);
  });

  it("has the built-in instructions equal to the first two lines of today's prompts", () => {
    const ctx: ReviewerContext = { spec: "Spec text", tasksDir: "/tasks", diff: "", changedFiles: ["a.ts"] };
    const firstTwo = (prompt: string) => prompt.split("\n").slice(0, 2).join("\n");
    expect(BUILTIN_INSTRUCTIONS.code).toBe(firstTwo(codeReviewerPrompt(ctx, 0, "/r.json")));
    expect(BUILTIN_INSTRUCTIONS.tester).toBe(firstTwo(testerPrompt(ctx, 0, "/r.json")));
    expect(parse([...BUILTIN_REVIEWERS])).toEqual(BUILTIN_REVIEWERS);
  });
});

describe("applyReviewDefaults", () => {
  const list = parse([code, { ...security, provider: "claude" }, { ...security, id: "perf", repoFile: "PERF.md", model: "own" }]);
  it("changes nothing when neither is set", () => {
    expect(applyReviewDefaults(list, {})).toEqual(list);
  });
  it("gives the review provider and model to the reviewers without their own provider", () => {
    const [c, s, p] = applyReviewDefaults(list, { reviewProvider: "codex", reviewModel: "o3" });
    expect(c).toMatchObject({ provider: "codex", model: "o3" });
    expect(s!.provider).toBe("claude");
    expect(s!.model).toBeUndefined();
    expect(p).toMatchObject({ provider: "codex", model: "own" });
  });
  it("applies the review model without a review provider, only to reviewers without their own provider", () => {
    const [c, s] = applyReviewDefaults(list, { reviewModel: "o3" });
    expect(c!.provider).toBeUndefined();
    expect(c!.model).toBe("o3");
    expect(s!.model).toBeUndefined();
  });
  it("applies them to the built-ins of a run without a reviewers file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-defaults-"));
    try {
      const got = await readRunReviewers(dir, { reviewProvider: "codex", reviewModel: "o3" });
      expect(got.map((r) => [r.id, r.provider, r.model])).toEqual([
        ["code", "codex", "o3"],
        ["tester", "codex", "o3"],
      ]);
      expect(BUILTIN_REVIEWERS[0]!.provider).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
