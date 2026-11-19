import { describe, expect, it } from "vitest";
import { errorText, escalationApi, lineDiff, summarizeDraft } from "./escalation.js";

const tasks = [
  { id: "1", content: "Set up the base.", dependencies: [] },
  { id: "2", content: "Build feature A.", dependencies: ["1"] },
  { id: "4", content: "Integrate A and B.\nRun the checks.", dependencies: ["2", "3"] },
];

describe("escalationApi", () => {
  it("builds relative URLs", () => {
    const api = escalationApi();
    expect(api.list).toBe("escalations");
    expect(api.draft("E1")).toBe("escalations/E1/draft");
    expect(api.tasks("E1")).toBe("escalations/E1/tasks");
    expect(api.resolve).toBe("escalations/resolve");
    for (const url of [api.list, api.draft("E1"), api.tasks("E1"), api.resolve]) expect(url.startsWith("/")).toBe(false);
  });
  it("prefixes and encodes", () => {
    const api = escalationApi("/api/");
    expect(api.list).toBe("api/escalations");
    expect(api.draft("E 1")).toBe("api/escalations/E%201/draft");
  });
});

describe("errorText", () => {
  it("reads the string shape", () => {
    expect(errorText({ error: "the run has ended" })).toBe("the run has ended");
  });
  it("reads the {code, message} shape", () => {
    expect(errorText({ error: { code: "task_started", message: "task 4 has started (running)" } })).toBe(
      "refused (task_started): task 4 has started (running)",
    );
    expect(errorText({ error: { message: "only a message" } })).toBe("only a message");
  });
  it("falls back without an error", () => {
    expect(errorText(null, "Request failed (500)")).toBe("Request failed (500)");
    expect(errorText({}, "x")).toBe("x");
  });
});

describe("summarizeDraft", () => {
  it("summarizes continue with guidance and answers", () => {
    const rows = summarizeDraft(
      {
        escalationIds: ["E1"],
        action: "continue",
        guidance: " Use B. ",
        answers: [{ escalationId: "E1", questionId: "q1", answer: "B" }],
      },
      tasks,
    );
    expect(rows).toEqual([
      { kind: "action", text: expect.stringContaining("Continue") },
      { kind: "guidance", text: "Use B." },
      { kind: "answer", escalationId: "E1", questionId: "q1", text: "B" },
    ]);
  });

  it("summarizes a change with edits, adds, removes and reopens", () => {
    const rows = summarizeDraft(
      {
        escalationIds: ["E1"],
        action: "change",
        editTasks: [
          { id: "4", content: "Integrate A and B.\nRun all checks.", dependencies: ["2"] },
          { id: "2", dependencies: ["1"] },
        ],
        addTasks: [{ id: "5", content: "Docs.", dependencies: ["4"] }],
        removeTasks: ["3"],
        reopen: ["1"],
      },
      tasks,
    );
    expect(rows.map((r) => r.kind)).toEqual(["action", "edit", "edit", "add", "remove", "reopen"]);
    expect(rows[1]).toEqual({
      kind: "edit",
      id: "4",
      before: "Integrate A and B.\nRun the checks.",
      after: "Integrate A and B.\nRun all checks.",
      depsBefore: ["2", "3"],
      depsAfter: ["2"],
      validate: false,
      missing: false,
    });
    // Only dependencies given: the content stays.
    expect(rows[2]).toMatchObject({ id: "2", before: "Build feature A.", after: "Build feature A.", depsAfter: ["1"] });
    expect(rows[3]).toEqual({ kind: "add", id: "5", content: "Docs.", dependencies: ["4"] });
    expect(rows[4]).toEqual({ kind: "remove", id: "3" });
    expect(rows[5]).toEqual({ kind: "reopen", id: "1" });
  });

  it("marks an edit of an unknown task", () => {
    const rows = summarizeDraft({ escalationIds: ["E1"], action: "change", editTasks: [{ id: "9", content: "x" }] }, tasks);
    expect(rows[1]).toMatchObject({ kind: "edit", id: "9", missing: true, before: "", after: "x" });
  });

  it("summarizes abort", () => {
    expect(summarizeDraft({ escalationIds: ["E1"], action: "abort" }, tasks)).toEqual([
      { kind: "action", text: "Abort the run" },
    ]);
  });
});

describe("lineDiff", () => {
  it("diffs lines into one hunk", () => {
    const d = lineDiff("4", "a\nb\nc", "a\nB\nc\nd");
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c", "add:d"]);
    expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
  });
  it("handles empty sides", () => {
    expect(lineDiff("x", "", "").hunks).toEqual([]);
    expect(lineDiff("x", "", "new").hunks[0]!.lines).toEqual([{ kind: "add", new: 1, text: "new" }]);
  });
});
