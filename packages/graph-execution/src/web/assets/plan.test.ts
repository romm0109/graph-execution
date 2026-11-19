import { describe, expect, it } from "vitest";
import { inPlanStage, planPanel, planPhaseIndex, planPhases, planStepLabel, safeUrl, specBlocks } from "./plan.js";

const base = { attempt: 1, attempts: 3, refs: [], questions: [], dropped: [], branch: "graph/r1" };

describe("planPhases / planPhaseIndex", () => {
  const phases = ["tasks", "validate", "review", "fix", "done"];
  it("puts a plan step first only for a planned run", () => {
    expect(planPhases(phases, undefined)).toEqual(phases);
    expect(planPhases(phases, { ...base, status: "planning" })).toEqual(["plan", ...phases]);
  });
  it("is 0 while the run is in its plan stage, -1 once its tasks run", () => {
    expect(planPhaseIndex(undefined)).toBe(-1);
    for (const status of ["planning", "needs-info", "awaiting-approval"]) expect(planPhaseIndex({ ...base, status })).toBe(0);
    expect(planPhaseIndex({ ...base, status: "failed", error: "x" })).toBe(0);
    expect(planPhaseIndex({ ...base, status: "running", name: "p" })).toBe(-1);
    expect(planPhaseIndex({ ...base, status: "failed", name: "p" })).toBe(-1);
  });
  it("labels the plan step by status", () => {
    expect(planStepLabel({ ...base, status: "planning" })).toBe("planning");
    expect(planStepLabel({ ...base, status: "needs-info" })).toBe("needs info");
    expect(planStepLabel({ ...base, status: "awaiting-approval", name: "p" })).toBe("waiting for approval");
  });
});

describe("planPanel", () => {
  it("shows the attempt, the refs and the rejected attempt's error while planning", () => {
    const p = planPanel({ ...base, status: "planning", attempt: 2, refs: [{ ref: "KAN-1", title: "Login" }, { ref: "KAN-2" }], lastError: "bad tasks" });
    expect(p?.title).toBe("Planning (attempt 2/3)");
    expect(p?.tone).toBe("running");
    expect(p?.lines).toEqual(["KAN-1 — Login", "KAN-2", "Previous attempt rejected: bad tasks"]);
  });

  it("groups the questions per ref at needs-info, with links only for http(s) urls", () => {
    const p = planPanel({
      ...base,
      status: "needs-info",
      refs: [
        { ref: "KAN-1", url: "https://jira.example/KAN-1", title: "Login" },
        { ref: "KAN-2", url: "javascript:alert(1)" },
      ],
      questions: [{ ref: "KAN-1", questions: ["Which IdP?"] }, { ref: "KAN-2", questions: ["Why?", "When?"] }],
      dropped: ["KAN-1", "KAN-2"],
    });
    expect(p?.title).toBe("Needs info");
    expect(p?.questions).toEqual([
      { ref: "KAN-1", url: "https://jira.example/KAN-1", title: "Login", questions: ["Which IdP?"] },
      { ref: "KAN-2", questions: ["Why?", "When?"] },
    ]);
    expect(p?.lines).toContain("This run is final: answer the questions and start a new run.");
  });

  it("shows the questions without refs at needs-info", () => {
    const p = planPanel({ ...base, status: "needs-info", questions: [{ questions: ["What is it?"] }] });
    expect(p?.questions).toEqual([{ questions: ["What is it?"] }]);
    expect(p?.lines).toEqual(["This run is final: answer the questions and start a new run."]);
  });

  it("links the spec and tasks, lists the dropped refs and gives both commands at awaiting-approval", () => {
    const p = planPanel({
      ...base,
      status: "awaiting-approval",
      name: "login",
      specRel: "docs/prd/login.md",
      spec: "# Login",
      tasks: [{ id: "1", title: "One", dependencies: [] }, { id: "2", title: "Two", dependencies: ["1"] }],
      refs: [{ ref: "KAN-1" }, { ref: "KAN-2", url: "http://x.example/2" }],
      dropped: ["KAN-2"],
      questions: [{ ref: "KAN-2", questions: ["Which page?"] }],
      approve: "graph-execution --resume --run r1 --approve-plan",
      replan: "graph-execution --resume --run r1 --replan <feedback.md>",
    });
    expect(p?.title).toBe("Waiting for approval: login");
    expect(p?.links).toEqual([
      { label: "Spec (docs/prd/login.md)", href: "#plan-spec" },
      { label: "Tasks (2)", href: "#plan-tasks" },
    ]);
    expect(p?.questions).toEqual([{ ref: "KAN-2", url: "http://x.example/2", questions: ["Which page?"] }]);
    expect(p?.lines[0]).toBe("Dropped (not ready): KAN-2");
    expect(p?.commands).toEqual([
      "graph-execution --resume --run r1 --approve-plan",
      "graph-execution --resume --run r1 --replan <feedback.md>",
    ]);
  });

  it("shows the error when planning failed", () => {
    const p = planPanel({ ...base, status: "failed", error: "the planner produced no result" });
    expect(p).toEqual(expect.objectContaining({ title: "Planning failed", tone: "bad", lines: ["the planner produced no result"] }));
  });

  it("keeps the dropped refs visible while the tasks run, and nothing otherwise", () => {
    const p = planPanel({ ...base, status: "running", name: "p", dropped: ["A", "B"], questions: [{ ref: "A", questions: ["?"] }] });
    expect(p?.title).toBe("Dropped: A, B");
    expect(p?.questions).toEqual([{ ref: "A", questions: ["?"] }, { ref: "B", questions: [] }]);
    expect(planPanel({ ...base, status: "running", name: "p" })).toBeUndefined();
    expect(planPanel(undefined)).toBeUndefined();
  });
});

describe("safeUrl", () => {
  it("allows only http and https", () => {
    expect(safeUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeUrl("http://a.example")).toBe("http://a.example");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,x")).toBeUndefined();
    expect(safeUrl("not a url")).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});

describe("inPlanStage", () => {
  it("is true for a planned run without task nodes", () => {
    const graph = (ids: string[]) => ({ nodes: ids.map((id) => ({ id })) });
    expect(inPlanStage({ plan: { ...base, status: "planning" }, graph: graph(["@gate", "@merge"]) })).toBe(true);
    expect(inPlanStage({ plan: { ...base, status: "running" }, graph: graph(["1", "@merge"]) })).toBe(false);
    expect(inPlanStage({ graph: graph([]) })).toBe(false);
  });
});

describe("specBlocks", () => {
  it("splits the spec at its headings, not inside code fences", () => {
    expect(specBlocks("# Title\n\nText\n\n## Sub ##\n```\n# not a heading\n```\n")).toEqual([
      { heading: "Title", level: 1 },
      { text: "\nText\n" },
      { heading: "Sub", level: 2 },
      { text: "```\n# not a heading\n```\n" },
    ]);
  });
});
