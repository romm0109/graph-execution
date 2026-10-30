import { describe, expect, it } from "vitest";
import type { TestPlan } from "../graph/testPlan.js";
import {
  type CaseResult,
  applyTestPlan,
  checkCommentVerdicts,
  checkPlanCases,
  coerceReport,
  countBySeverity,
  countFixed,
  type Finding,
  normalizeReport,
  openBlocking,
  planStats,
  extractReportFromText,
  parseReportText,
  type Report,
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
      findings: [
        {
          ...finding(),
          file: "src/a.ts",
          line: 42,
          suggestedFix: "Use < instead of <=.",
        },
      ],
    };
    expect(reportSchema.safeParse(report).success).toBe(true);
    expect(
      reportSchema.safeParse({
        ...report,
        findings: [{ ...finding(), severity: "critical" }],
      }).success,
    ).toBe(false);
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
    expect(countBySeverity(report.findings)).toEqual({
      blocker: 1,
      major: 0,
      minor: 3,
    });
    expect(openBlocking(report).map((f) => f.id)).toEqual(["F3"]);
  });

  it("counts blockers verified as not fixed as open", () => {
    const report = {
      round: 1,
      reviewer: "code" as const,
      findings: [finding({ status: "not_fixed" })],
    };
    expect(openBlocking(report)).toHaveLength(1);
  });

  it("does not count fixed blockers as open", () => {
    const report = {
      round: 1,
      reviewer: "code" as const,
      findings: [finding({ status: "fixed" })],
    };
    expect(openBlocking(report)).toEqual([]);
  });
});

describe("countBySeverity and countFixed", () => {
  const findings = [
    finding({ id: "F1", severity: "blocker", status: "fixed" }),
    finding({ id: "F2", severity: "blocker", status: "not_fixed" }),
    finding({ id: "F3", severity: "major", status: "open" }),
    finding({ id: "F4", severity: "minor", status: "fixed" }),
  ];

  it("counts only findings that are not fixed", () => {
    expect(countBySeverity(findings)).toEqual({ blocker: 1, major: 1, minor: 0 });
  });

  it("counts only fixed findings", () => {
    expect(countFixed(findings)).toBe(2);
  });
});

describe("renderMarkdown", () => {
  it("shows open counts and the number fixed, still listing every finding", () => {
    const md = renderMarkdown({
      round: 1,
      reviewer: "code",
      findings: [
        finding({ id: "F1", severity: "blocker", status: "fixed" }),
        finding({ id: "F2", severity: "major", status: "open" }),
      ],
    });
    expect(md).toContain("0 blocker, 1 major, 0 minor (1 fixed)");
    expect(md).toContain("**F1** (fixed)");
    expect(md).toContain("**F2** (open)");
  });

  it("renders counts, notes and findings grouped by severity", () => {
    const md = renderMarkdown({
      round: 0,
      reviewer: "code",
      summary: "Mostly fine.",
      notes: ["live test not performed"],
      findings: [
        finding({ file: "src/a.ts", line: 3, suggestedFix: "Fix the bound." }),
        finding({ id: "F2", severity: "minor" }),
      ],
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
        {
          severity: "Critical",
          description: "a",
          failureScenario: "x",
          line: "12",
        },
        {
          id: "F9",
          severity: "HIGH",
          description: "b",
          failureScenario: "y",
          status: "Not Fixed",
          file: null,
        },
      ],
    };
    const parsed = reportSchema.parse(coerceReport(raw, 2, "tester"));
    expect(parsed.round).toBe(2);
    expect(parsed.reviewer).toBe("tester");
    expect(parsed.findings[0]).toMatchObject({
      id: "F1",
      severity: "blocker",
      status: "open",
      line: 12,
    });
    expect(parsed.findings[1]).toMatchObject({
      id: "F9",
      severity: "major",
      status: "not_fixed",
    });
    expect(parsed.findings[1]!.file).toBeUndefined();
  });

  it("wraps a bare findings array and leaves what it cannot repair to the schema", () => {
    expect(reportSchema.safeParse(coerceReport([], 0, "code")).success).toBe(true);
    expect(reportSchema.safeParse(coerceReport({ round: 0, reviewer: "code" }, 0, "code")).success).toBe(false);
    expect(
      reportSchema.safeParse(coerceReport({ findings: [{ severity: "bad", description: "x" }] }, 0, "code")).success,
    ).toBe(false);
  });
});

describe("parseReportText", () => {
  it("reads plain JSON and JSON inside a Markdown fence", () => {
    expect(parseReportText('{"a":1}')).toEqual({ a: 1 });
    expect(parseReportText('Here is the report:\n```json\n{"a":2}\n```\n')).toEqual({ a: 2 });
    expect(() => parseReportText("not json")).toThrow();
  });
});

describe("test plan cases", () => {
  const plan: TestPlan = {
    cases: ["P1", "P2", "P3"].map((id) => ({
      id,
      title: id,
      steps: ["s"],
      expected: "e",
      priority: "must" as const,
    })),
  };
  const res = (id: string, extra: Partial<CaseResult> = {}): CaseResult => ({
    id,
    verdict: "pass",
    evidence: "ok",
    ...extra,
  });
  const report = (cases: CaseResult[], notes?: string[]) =>
    reportSchema.parse({
      round: 0,
      reviewer: "tester",
      findings: [],
      cases,
      ...(notes ? { notes } : {}),
    });

  it("accepts a report that covers every case", () => {
    expect(checkPlanCases(report([res("P1"), res("P2"), res("P3")]), plan)).toEqual([]);
  });

  it("names missing, unknown, duplicate and evidence-less cases in order", () => {
    expect(checkPlanCases(report([res("P1"), res("P3")]), plan)).toEqual(["the report has no verdict for case(s) P2"]);
    expect(checkPlanCases(report([res("P1"), res("P2"), res("P3"), res("X1")]), plan)).toEqual([
      "the report has verdicts for unknown case(s) X1",
    ]);
    expect(checkPlanCases(report([res("P1"), res("P1"), res("P2"), res("P3")]), plan)).toEqual([
      "case(s) P1 are reported more than once",
    ]);
    expect(
      checkPlanCases(
        report([
          res("P1"),
          res("P2", { verdict: "fail", evidence: "  " }),
          res("P3", { verdict: "blocked", evidence: undefined }),
        ]),
        plan,
      ),
    ).toEqual(["case(s) P2, P3 have a fail or blocked verdict without evidence"]);
  });

  it("allows no cases when the live test was not performed", () => {
    expect(checkPlanCases(report([], ["live test not performed: no server"]), plan)).toEqual([]);
  });

  it("coerces verdict spellings", () => {
    const raw = coerceReport(
      {
        findings: [],
        cases: [
          { id: "P1", verdict: " PASSED " },
          { id: "P2", verdict: "Skipped" },
        ],
      },
      0,
      "tester",
    );
    expect(reportSchema.parse(raw).cases?.map((c) => c.verdict)).toEqual(["pass", "blocked"]);
  });
});

describe("applyTestPlan", () => {
  const plan: TestPlan = {
    cases: [
      { id: "A", title: "Must A", steps: ["s"], expected: "e", priority: "must" },
      { id: "B", title: "Should B", steps: ["s"], expected: "e", priority: "should" },
    ],
  };
  const rep = (cases: CaseResult[], extra: Partial<Report> = {}): Report => ({
    round: 0,
    reviewer: "tester",
    findings: [],
    cases,
    ...extra,
  });
  const r = (id: string, verdict: CaseResult["verdict"]): CaseResult => ({ id, verdict, evidence: `ev ${id}` });
  const sev = (rep: Report, id: string) => rep.findings.find((f) => f.id === id)?.severity;

  it("maps every verdict and priority", () => {
    const out = applyTestPlan(rep([r("A", "fail"), r("B", "fail")]), plan);
    expect(sev(out, "plan-A")).toBe("blocker");
    expect(sev(out, "plan-B")).toBe("major");
    expect(out.findings[0]).toMatchObject({ description: "Must A", failureScenario: "ev A", status: "open" });
    const blocked = applyTestPlan(rep([r("A", "blocked"), r("B", "blocked")]), plan);
    expect(sev(blocked, "plan-A")).toBe("major");
    expect(sev(blocked, "plan-B")).toBe("major");
    expect(applyTestPlan(rep([r("A", "pass"), r("B", "pass")]), plan).findings).toEqual([]);
  });

  it("follows open → not_fixed → fixed and fills titles and priorities", () => {
    const r0 = applyTestPlan(rep([r("A", "fail"), r("B", "pass")]), plan);
    const r1 = applyTestPlan(rep([r("A", "fail"), r("B", "pass")]), plan, r0);
    expect(r1.findings[0]!.status).toBe("not_fixed");
    const r2 = applyTestPlan(rep([r("A", "pass"), r("B", "pass")]), plan, r1);
    expect(r2.findings).toHaveLength(1);
    expect(r2.findings[0]!.status).toBe("fixed");
    expect(openBlocking(r2)).toEqual([]);
    expect(r2.cases![0]).toMatchObject({ title: "Must A", priority: "must" });
  });

  it("drops unknown cases and tester-written plan findings", () => {
    const own: Finding = { id: "plan-A", severity: "blocker", description: "x", failureScenario: "y", status: "open" };
    const out = applyTestPlan(rep([r("A", "pass"), r("B", "pass"), r("Z", "fail")], { findings: [own] }), plan);
    expect(out.cases!.map((x) => x.id)).toEqual(["A", "B"]);
    expect(out.findings).toEqual([]);
  });

  it("blocks every case without findings when the live test was not performed", () => {
    const out = applyTestPlan(rep([], { notes: ["live test not performed: no server"] }), plan);
    expect(out.cases!.map((x) => x.verdict)).toEqual(["blocked", "blocked"]);
    expect(out.findings).toEqual([]);
  });
});

describe("planStats", () => {
  const tester = (cases?: CaseResult[]): Report => ({ round: 1, reviewer: "tester", findings: [], cases });
  it("is undefined without cases", () => {
    expect(planStats(undefined)).toBeUndefined();
    expect(planStats(tester())).toBeUndefined();
    expect(planStats(tester([]))).toBeUndefined();
  });
  it("counts the verdicts", () => {
    const cases: CaseResult[] = [
      { id: "P1", verdict: "pass" },
      { id: "P2", verdict: "pass" },
      { id: "P3", verdict: "fail" },
      { id: "P4", verdict: "blocked" },
    ];
    expect(planStats(tester(cases))).toEqual({ total: 4, passed: 2, failed: 1, blocked: 1 });
  });
});

describe("comment verdicts", () => {
  const rep = (comments: unknown[]) =>
    reportSchema.parse({ round: 1, reviewer: "code", findings: [], comments });
  const c = (id: string, evidence = "src/a.ts:1") => ({ id, verdict: "addressed", evidence });

  it("accepts one verdict with evidence per comment", () => {
    expect(checkCommentVerdicts(rep([c("H1-1"), c("H1-2")]), [{ id: "H1-1" }, { id: "H1-2" }])).toEqual([]);
  });

  it("names missing, unknown, duplicate and evidence-less verdicts", () => {
    const ids = [{ id: "H1-1" }, { id: "H1-2" }];
    expect(checkCommentVerdicts(rep([c("H1-1")]), ids)).toEqual(["the report has no verdict for comment(s) H1-2"]);
    expect(checkCommentVerdicts(rep([c("H1-1"), c("H1-2"), c("X")]), ids)).toEqual(["unknown comment id(s) X"]);
    expect(checkCommentVerdicts(rep([c("H1-1"), c("H1-1"), c("H1-2")]), ids)).toEqual(["comment H1-1 has two verdicts"]);
    expect(checkCommentVerdicts(rep([c("H1-1", " "), c("H1-2")]), ids)).toEqual(["comment H1-1 has no evidence"]);
  });

  it("repairs verdict aliases", () => {
    const raw = coerceReport({ findings: [], comments: [{ id: "H1-1", verdict: "Fixed" }, { id: "H1-2", verdict: "no" }] }, 1, "code");
    expect(reportSchema.parse(raw).comments?.map((v) => v.verdict)).toEqual(["addressed", "not_addressed"]);
  });
});

describe("extractReportFromText", () => {
  it("finds the last fenced JSON object, or a bare one inside prose", () => {
    expect(extractReportFromText('done\n```json\n{"a":1}\n```\nand\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractReportFromText('Here is my report: {"a":3} thanks')).toEqual({ a: 3 });
    expect(extractReportFromText("no json here")).toBeUndefined();
  });
});
