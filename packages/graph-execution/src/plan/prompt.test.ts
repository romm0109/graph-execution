import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SKILLS_SOURCE } from "../install/skills.js";
import { PLAN_CONTENT_PATH_PATTERN, PLAN_REFS_PATH_PATTERN, PLAN_RESULT_PATH_PATTERN, plannerPrompt, validateTasksScript } from "./prompt.js";

describe("plannerPrompt", () => {
  it("has the headless preamble, both bundled skills, the content, the taken names and the result path", async () => {
    const prompt = await plannerPrompt({
      content: "# Build a widget\n\nIt should spin.",
      contentPath: "/r/plan/content.md",
      resultPath: "/r/plan/result.json",
      taken: ["old-plan", "other"],
      validateScript: validateTasksScript(),
      feedback: [],
    });
    for (const skill of ["to-spec", "to-tasks"]) {
      expect(prompt).toContain((await readFile(path.join(SKILLS_SOURCE, skill, "SKILL.md"), "utf8")).trimEnd());
    }
    expect(prompt).toContain("Never ask a question");
    expect(prompt).toContain("It should spin.");
    expect(prompt).toContain("`old-plan`, `other`");
    expect(prompt).toContain(`node ${path.join(SKILLS_SOURCE, "to-tasks", "validate-tasks.mjs")} .agents/tasks/<name>`);
    expect(path.isAbsolute(validateTasksScript())).toBe(true);
    expect(PLAN_RESULT_PATH_PATTERN.exec(prompt)?.[1]).toBe("/r/plan/result.json");
    expect(PLAN_CONTENT_PATH_PATTERN.exec(prompt)?.[1]).toBe("/r/plan/content.md");
  });

  it("says none when no name is taken", async () => {
    const prompt = await plannerPrompt({ content: "x", contentPath: "/c", resultPath: "/r", taken: [], validateScript: "/v.mjs", feedback: [] });
    expect(prompt).toContain("Names already taken: none.");
  });

  it("asks for readiness of the whole content without refs, with no Previous attempt section on the first round", async () => {
    const prompt = await plannerPrompt({ content: "x", contentPath: "/c", resultPath: "/r", taken: [], validateScript: "/v.mjs", feedback: [] });
    expect(prompt).toContain("First decide whether the content can be built as written");
    expect(prompt).toContain('{"ready": false, "questions"');
    expect(prompt).not.toContain("## Refs");
    expect(prompt).not.toContain("## Previous attempt");
    expect(PLAN_REFS_PATH_PATTERN.exec(prompt)).toBeNull();
  });

  it("lists the refs and the refs result shape with refs", async () => {
    const prompt = await plannerPrompt({
      content: "x",
      contentPath: "/c",
      resultPath: "/r",
      taken: [],
      validateScript: "/v.mjs",
      feedback: [],
      refs: [{ ref: "KAN-41", title: "Login", url: "https://j/KAN-41" }, { ref: "KAN-42" }],
      refsPath: "/run/plan/refs.json",
    });
    expect(prompt).toContain("## Refs");
    expect(prompt).toContain("- KAN-41: Login (https://j/KAN-41)");
    expect(prompt).toContain("- KAN-42\n");
    expect(prompt).toContain("Plan only the ready refs");
    expect(prompt).toContain('"notReady"');
    expect(PLAN_REFS_PATH_PATTERN.exec(prompt)?.[1]).toBe("/run/plan/refs.json");
  });

  it("tells a retried planner why its previous attempt was rejected", async () => {
    const prompt = await plannerPrompt({
      content: "x",
      contentPath: "/c",
      resultPath: "/r",
      taken: [],
      validateScript: "/v.mjs",
      feedback: [],
      previousError: "task 1 depends on itself",
    });
    expect(prompt).toContain("## Previous attempt");
    expect(prompt).toContain("The engine rejected your previous attempt: task 1 depends on itself.");
  });

  it("has no feedback section without feedback", async () => {
    const prompt = await plannerPrompt({ content: "x", contentPath: "/c", resultPath: "/r", taken: [], validateScript: "/v.mjs", feedback: [] });
    expect(prompt).not.toContain("## Feedback on earlier plans");
  });

  it("lists the feedback of rejected plans, oldest first, and names the rejected commit", async () => {
    const prompt = await plannerPrompt({
      content: "x",
      contentPath: "/c",
      resultPath: "/r",
      taken: [],
      validateScript: "/v.mjs",
      feedback: ["Split it in two", "Use smaller tasks"],
      rejectedCommit: "abc123",
      previousError: "bad",
    });
    expect(prompt).toContain("## Feedback on earlier plans");
    expect(prompt).toContain("Write a new plan that answers all of it.");
    expect(prompt).toContain("The last rejected plan is commit `abc123`: read it with `git show abc123`.");
    expect(prompt.indexOf("Split it in two")).toBeLessThan(prompt.indexOf("Use smaller tasks"));
    expect(prompt.indexOf("### Feedback 1")).toBeLessThan(prompt.indexOf("### Feedback 2"));
    expect(prompt.indexOf("## Feedback on earlier plans")).toBeLessThan(prompt.indexOf("## Result"));
    expect(prompt).toContain("## Previous attempt");
  });
});
