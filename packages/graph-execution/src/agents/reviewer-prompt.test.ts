import { describe, expect, it } from "vitest";
import type { ReviewerContext } from "../review/context.js";
import { BUILTIN_REVIEWERS } from "../review/reviewers.js";
import { codeReviewerPrompt } from "./reviewer.js";

const ctx: ReviewerContext = {
  spec: "# Spec\n",
  tasksDir: "/tasks",
  diff: "diff --git a/a b/a\n",
  changedFiles: ["a"],
  repoFiles: { "SECURITY_REVIEW.md": "Public: /health\n", "REVIEW.md": "No console.log\n" },
};
const security = { id: "security", name: "Security", instructions: "Check auth.", repoFile: "SECURITY_REVIEW.md" };

describe("codeReviewerPrompt per reviewer", () => {
  it("defaults to the built-in code reviewer", () => {
    expect(codeReviewerPrompt(ctx, 0, "/r.json")).toBe(codeReviewerPrompt(ctx, 0, "/r.json", undefined, [], BUILTIN_REVIEWERS[0]));
    expect(codeReviewerPrompt(ctx, 0, "/r.json")).toContain("## Review rules (REVIEW.md)\n\nNo console.log\n");
  });

  it("uses the reviewer's instructions and only its own repo file", () => {
    const prompt = codeReviewerPrompt(ctx, 0, "/r.json", undefined, [], security);
    expect(prompt.startsWith("Check auth.\n")).toBe(true);
    expect(prompt).toContain("## Review rules (SECURITY_REVIEW.md)");
    expect(prompt).toContain("Public: /health");
    expect(prompt).toContain("- Review the diff as your instructions above ask, and against the rules in SECURITY_REVIEW.md above.");
    expect(prompt).not.toContain("No console.log");
    expect(prompt).not.toContain("You are the code reviewer");
    expect(prompt).toContain('`reviewer` "security"');
    expect(prompt).toContain('"reviewer": "security"');
  });

  it("falls back to a role line with the reviewer's name when its instructions are empty", () => {
    const prompt = codeReviewerPrompt({ ...ctx, repoFiles: {} }, 0, "/r.json", undefined, [], { ...security, instructions: " " });
    expect(prompt.startsWith("You are the Security reviewer of a change set")).toBe(true);
    expect(prompt).toContain("- Review the diff as your instructions above ask.\n");
  });
});
