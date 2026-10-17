import { z } from "zod";

export const severitySchema = z.enum(["blocker", "major", "minor"]);
export type Severity = z.infer<typeof severitySchema>;

export const reviewerKindSchema = z.enum(["code", "tester"]);
export type ReviewerKind = z.infer<typeof reviewerKindSchema>;

export const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  file: z.string().optional(),
  line: z.number().int().optional(),
  description: z.string().min(1),
  /** A concrete scenario in which the defect shows; blockers and majors without one are downgraded to minor. */
  failureScenario: z.string().optional(),
  suggestedFix: z.string().optional(),
  status: z.enum(["open", "fixed", "not_fixed"]),
});
export type Finding = z.infer<typeof findingSchema>;

/** A reviewer's report, `.graph-execution/<run-id>/reports/round<N>/<reviewer>.json` (PRD §7.5). */
export const reportSchema = z.object({
  round: z.number().int().min(0),
  reviewer: reviewerKindSchema,
  summary: z.string().optional(),
  /** Informational notes, e.g. "live test not performed". */
  notes: z.array(z.string()).optional(),
  findings: z.array(findingSchema),
});
export type Report = z.infer<typeof reportSchema>;

export const SEVERITIES: readonly Severity[] = severitySchema.options;

/** Downgrades every blocker or major finding without a concrete failure scenario to minor (PRD §7.5). */
export function normalizeReport(report: Report): Report {
  return {
    ...report,
    findings: report.findings.map((f) =>
      f.severity !== "minor" && !f.failureScenario?.trim() ? { ...f, severity: "minor" } : f,
    ),
  };
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/**
 * Unresolved blocker and major findings: the ones that keep the review loop going (PRD §7.6). A previous finding the
 * reviewer verified as `not_fixed` is still open; only `fixed` resolves one.
 */
export const openBlocking = (report: Report): Finding[] =>
  report.findings.filter((f) => f.status !== "fixed" && f.severity !== "minor");

/** Markdown rendering of a report, for the TUI. */
export function renderMarkdown(report: Report): string {
  const title = report.reviewer === "code" ? "Code review" : "Live test";
  const counts = countBySeverity(report.findings);
  const out = [
    `# ${title} — round ${report.round}`,
    "",
    SEVERITIES.map((s) => `${counts[s]} ${s}`).join(", "),
    "",
  ];
  if (report.summary) out.push(report.summary, "");
  for (const note of report.notes ?? []) out.push(`> ${note}`, "");
  for (const severity of SEVERITIES) {
    const findings = report.findings.filter((f) => f.severity === severity);
    if (findings.length === 0) continue;
    out.push(`## ${severity[0]!.toUpperCase()}${severity.slice(1)}`, "");
    for (const f of findings) {
      const where = f.file ? ` \`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\`` : "";
      out.push(`- **${f.id}** (${f.status})${where}: ${f.description}`);
      if (f.failureScenario) out.push(`  - Failure scenario: ${f.failureScenario}`);
      if (f.suggestedFix) out.push(`  - Suggested fix: ${f.suggestedFix}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** The prompt line that tells a reviewer where to write its report; the fake provider parses it back. */
export const reportPathLine = (file: string): string => `Write the JSON report to this absolute path: \`${file}\``;
export const REPORT_PATH_PATTERN = /Write the JSON report to this absolute path: `([^`]+)`/;
