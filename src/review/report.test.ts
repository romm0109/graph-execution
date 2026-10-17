import { describe, expect, it } from "vitest";
import { countBySeverity, type Finding, normalizeReport, openBlocking, renderMarkdown, reportSchema } from "./report.js";

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
