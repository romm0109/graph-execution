import { describe, expect, it } from "vitest";
import {
  coerceReport,
  countBySeverity,
  type Finding,
  normalizeReport,
  openBlocking,
  parseReportText,
  renderMarkdown,
  reportSchema,
} from "./report.js";

const finding = (extra: Partial<Finding> = {}): Finding => ({
  id: "F1",
  severity: "major",
  description: "Off by one in the pager.",
  failureScenario: "Requesting page 2 of 10 items with size 5 returns items 6-11.",
  status: "open",
  ...extra,
});

describe("reportSchema", () => {
  it("accepts the PRD example and rejects unknown severities or a missing findings list", () => {
    const report = {
      round: 1,
      reviewer: "code",
      findings: [{ ...finding(), file: "src/a.ts", line: 42, suggestedFix: "Use < instead of <=." }],
    };
    expect(reportSchema.safeParse(report).success).toBe(true);
    expect(reportSchema.safeParse({ ...report, findings: [{ ...finding(), severity: "critical" }] }).success).toBe(false);
    expect(reportSchema.safeParse({ round: 0, reviewer: "code" }).success).toBe(false);
    expect(reportSchema.safeParse({ round: 0, reviewer: "linter", findings: [] }).success).toBe(false);
  });
});

describe("normalizeReport", () => {
  it("downgrades blockers and majors without a failure scenario to minor", () => {
    const report = normalizeReport({
      round: 0,
      reviewer: "code",
      findings: [
        finding({ id: "F1", severity: "blocker", failureScenario: undefined }),
        finding({ id: "F2", severity: "major", failureScenario: "   " }),
        finding({ id: "F3", severity: "blocker" }),
        finding({ id: "F4", severity: "minor", failureScenario: undefined }),
      ],
    });
    expect(report.findings.map((f) => [f.id, f.severity])).toEqual([
      ["F1", "minor"],
      ["F2", "minor"],
      ["F3", "blocker"],
      ["F4", "minor"],
    ]);
    expect(countBySeverity(report.findings)).toEqual({ blocker: 1, major: 0, minor: 3 });
    expect(openBlocking(report).map((f) => f.id)).toEqual(["F3"]);
  });

  it("counts blockers verified as not fixed as open", () => {
    const report = { round: 1, reviewer: "code" as const, findings: [finding({ status: "not_fixed" })] };
    expect(openBlocking(report)).toHaveLength(1);
  });

  it("does not count fixed blockers as open", () => {
    const report = { round: 1, reviewer: "code" as const, findings: [finding({ status: "fixed" })] };
    expect(openBlocking(report)).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  it("renders counts, notes and findings grouped by severity", () => {
    const md = renderMarkdown({
      round: 0,
      reviewer: "code",
      summary: "Mostly fine.",
      notes: ["live test not performed"],
      findings: [finding({ file: "src/a.ts", line: 3, suggestedFix: "Fix the bound." }), finding({ id: "F2", severity: "minor" })],
    });
    expect(md).toContain("# Code review — round 0");
    expect(md).toContain("0 blocker, 1 major, 1 minor");
    expect(md).toContain("> live test not performed");
    expect(md).toContain("## Major");
    expect(md).toContain("- **F1** (open) `src/a.ts:3`: Off by one in the pager.");
    expect(md).toContain("  - Suggested fix: Fix the bound.");
    expect(md.indexOf("## Major")).toBeLessThan(md.indexOf("## Minor"));
  });
});

describe("coerceReport", () => {
  it("repairs case, aliases, a missing status and id, numeric strings and missing round/reviewer", () => {
    const raw = {
      findings: [
        { severity: "Critical", description: "a", failureScenario: "x", line: "12" },
        { id: "F9", severity: "HIGH", description: "b", failureScenario: "y", status: "Not Fixed", file: null },
      ],
    };
    const parsed = reportSchema.parse(coerceReport(raw, 2, "tester"));
    expect(parsed.round).toBe(2);
    expect(parsed.reviewer).toBe("tester");
    expect(parsed.findings[0]).toMatchObject({ id: "F1", severity: "blocker", status: "open", line: 12 });
    expect(parsed.findings[1]).toMatchObject({ id: "F9", severity: "major", status: "not_fixed" });
    expect(parsed.findings[1]!.file).toBeUndefined();
  });

  it("wraps a bare findings array and leaves what it cannot repair to the schema", () => {
    expect(reportSchema.safeParse(coerceReport([], 0, "code")).success).toBe(true);
    expect(reportSchema.safeParse(coerceReport({ round: 0, reviewer: "code" }, 0, "code")).success).toBe(false);
    expect(reportSchema.safeParse(coerceReport({ findings: [{ severity: "bad", description: "x" }] }, 0, "code")).success).toBe(false);
  });
});

describe("parseReportText", () => {
  it("reads plain JSON and JSON inside a Markdown fence", () => {
    expect(parseReportText('{"a":1}')).toEqual({ a: 1 });
    expect(parseReportText('Here is the report:\n```json\n{"a":2}\n```\n')).toEqual({ a: 2 });
    expect(() => parseReportText("not json")).toThrow();
  });
});
