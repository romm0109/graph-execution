import { describe, expect, it } from "vitest";
import type { TestPlan } from "../graph/testPlan.js";
import type { ReviewerContext } from "../review/context.js";
import { testerPrompt } from "./tester.js";

const ctx: ReviewerContext = {
  spec: "Spec text",
  tasksDir: "/tasks",
  diff: "",
  changedFiles: ["a.ts"],
};
const plan: TestPlan = {
  cases: [
    {
      id: "P1",
      title: "Login works",
      steps: ["Open the page", "Submit"],
      expected: "Dashboard",
      priority: "must",
    },
    {
      id: "P2",
      title: "Expired token",
      steps: ["Call the API"],
      expected: "401",
      priority: "should",
    },
  ],
};

describe("testerPrompt", () => {
  it("is unchanged without a test plan", () => {
    expect(testerPrompt(ctx, 0, "/r/tester.json")).toMatchInlineSnapshot(`
      "You are the live tester of a change set built by AI coding agents from the specification below.
      Run the result and check that it behaves as the specification asks.

      ## Specification

      Spec text

      ## Tasks

      The change set was built from the task files (JSON) in \`/tasks\`. You may read them if useful.

      ## Changed files

      Files changed by the change set, as a hint for what to exercise:

      - a.ts

      ## Instructions

      - There is no TESTING.md: work out how to boot the app from the README and the package scripts (best effort).
      - The current directory is a checkout of the integrated result; boot the app from here.
      - Exercise the behavior the specification asks for: call the API, or drive the UI with an available browser
        automation tool.
      - Do NOT modify, create or delete code files, and do not commit: this checkout is thrown away after the test.
      - Stop every server or process you started before you finish. Anything left running is killed when you exit.
      - Every blocker or major finding needs a concrete \`failureScenario\` (the requests, inputs or steps and what went
        wrong). Findings without one are downgraded to minor.
      - Give every finding a unique \`id\` (T1, T2, ...) and \`status: "open"\`.
      - If you cannot run the app at all, do not fail: add a note "live test not performed: <reason>" to \`notes\` and
        report no findings.

      ## Report

      Write the JSON report to this absolute path: \`/r/tester.json\`
      (it is outside the current directory; create it there and nowhere else).
      It must be a JSON object of this shape, with \`round\` 0 and \`reviewer\` "tester"; \`file\`, \`line\`,
      \`summary\`, \`notes\`, \`failureScenario\` and \`suggestedFix\` are optional, \`findings\` may be empty:

      \`\`\`
      {
        "round": 0,
        "reviewer": "tester",
        "summary": "...",
        "notes": [
          "..."
        ],
        "findings": [
          {
            "id": "T1",
            "severity": "blocker|major|minor",
            "file": "src/a.ts",
            "line": 42,
            "description": "...",
            "failureScenario": "...",
            "suggestedFix": "...",
            "status": "open"
          }
        ]
      }
      \`\`\`
      "
    `);
  });

  it("lists every case and asks for cases with a plan", () => {
    const prompt = testerPrompt({ ...ctx, testPlan: plan }, 0, "/r/tester.json");
    expect(prompt).toContain("## Test plan");
    expect(prompt).toContain("### P1 (must): Login works");
    expect(prompt).toContain("### P2 (should): Expired token");
    expect(prompt).toContain("1. Open the page");
    expect(prompt).toContain("Expected: 401");
    expect(prompt).toContain("Report a verdict for EVERY test plan case");
    expect(prompt).toContain('"verdict": "pass|fail|blocked"');
    expect(prompt).toContain('"id": "P1"');
    expect(prompt).toContain("`cases` is required");
  });
});
