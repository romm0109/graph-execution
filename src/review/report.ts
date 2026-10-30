import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { TestPlan } from "../graph/testPlan.js";

export const severitySchema = z.enum(["blocker", "major", "minor"]);
export type Severity = z.infer<typeof severitySchema>;

export const reviewerKindSchema = z.enum(["code", "tester"]);
export type ReviewerKind = z.infer<typeof reviewerKindSchema>;

export const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  file: z.string().optional(),
  line: z.number().int().optional(),
  endLine: z.number().int().optional(),
  side: z.enum(["new", "old"]).optional(),
  description: z.string().min(1),
  /** A concrete scenario in which the defect shows; blockers and majors without one are downgraded to minor. */
  failureScenario: z.string().optional(),
  suggestedFix: z.string().optional(),
  status: z.enum(["open", "fixed", "not_fixed"]),
});
export type Finding = z.infer<typeof findingSchema>;

export const verdictSchema = z.enum(["pass", "fail", "blocked"]);
export type Verdict = z.infer<typeof verdictSchema>;
export const caseResultSchema = z.object({
  id: z.string().min(1),
  verdict: verdictSchema,
  evidence: z.string().optional(),
  // Filled in by the tool from the plan, never by the tester:
  title: z.string().optional(),
  priority: z.enum(["must", "should"]).optional(),
});
export type CaseResult = z.infer<typeof caseResultSchema>;

export const commentVerdictSchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(["addressed", "not_addressed"]),
  evidence: z.string().optional(),
});
export type CommentVerdict = z.infer<typeof commentVerdictSchema>;

/** A reviewer's report, `.graph-execution/<run-id>/reports/round<N>/<reviewer>.json` (PRD §7.5). */
export const reportSchema = z.object({
  round: z.number().int().min(0),
  reviewer: reviewerKindSchema,
  summary: z.string().optional(),
  /** Informational notes, e.g. "live test not performed". */
  notes: z.array(z.string()).optional(),
  findings: z.array(findingSchema),
  /** The live tester's verdict for each test plan case. */
  cases: z.array(caseResultSchema).optional(),
  /** The code reviewer's verdict for each open human review comment. */
  comments: z.array(commentVerdictSchema).optional(),
});
export type Report = z.infer<typeof reportSchema>;

export const SEVERITIES: readonly Severity[] = severitySchema.options;

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "blocker",
  high: "major",
  medium: "minor",
  low: "minor",
};
const STATUS_ALIASES: Record<string, Finding["status"]> = {
  "not fixed": "not_fixed",
  "not-fixed": "not_fixed",
  unfixed: "not_fixed",
};

const VERDICT_ALIASES: Record<string, Verdict> = {
  passed: "pass",
  failed: "fail",
  skipped: "blocked",
};

const COMMENT_VERDICT_ALIASES: Record<string, CommentVerdict["verdict"]> = {
  fixed: "addressed",
  done: "addressed",
  yes: "addressed",
  resolved: "addressed",
  not_fixed: "not_addressed",
  open: "not_addressed",
  no: "not_addressed",
  missing: "not_addressed",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lower = (v: unknown): unknown => (typeof v === "string" ? v.trim().toLowerCase() : v);
const toInt = (v: unknown): unknown => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v);

/**
 * Parses a report file's text: the JSON itself, or the JSON inside a Markdown code fence, which agents sometimes
 * write. Throws on anything else.
 */
export function parseReportText(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  return JSON.parse(fenced ? fenced[1]! : text);
}

/**
 * Looks for a JSON object report in free text, e.g. an agent's final message: the last fenced block that parses, else
 * the span from the first `{` to the last `}`. Returns undefined when there is none.
 */
export function extractReportFromText(text: string): unknown | undefined {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)) candidates.push(m[1]!);
  candidates.reverse();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (isRecord(v) || Array.isArray(v)) return v;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Repairs the unambiguous slips agents make in a report before the strict schema check: a bare findings array,
 * missing `round`/`reviewer` (the tool knows them), severity and status in another case or a common alias
 * (`critical`, `high`, `not fixed`), a missing status (`open`), numeric strings for `line`, and numbered finding ids
 * when they are missing. Anything it cannot repair is left for the schema to reject.
 */
export function coerceReport(raw: unknown, round: number, kind: ReviewerKind): unknown {
  const report = Array.isArray(raw) ? { findings: raw } : raw;
  if (!isRecord(report)) return raw;
  const findings = Array.isArray(report.findings)
    ? report.findings.map((f, i) => {
        if (!isRecord(f)) return f;
        const severity = lower(f.severity);
        const status = lower(f.status ?? "open");
        return {
          ...f,
          id: f.id ?? `F${i + 1}`,
          severity: typeof severity === "string" ? (SEVERITY_ALIASES[severity] ?? severity) : severity,
          status: typeof status === "string" ? (STATUS_ALIASES[status] ?? status) : status,
          ...(f.line === undefined || f.line === null ? { line: undefined } : { line: toInt(f.line) }),
          ...(f.endLine === undefined || f.endLine === null ? { endLine: undefined } : { endLine: toInt(f.endLine) }),
          ...(f.file === null ? { file: undefined } : {}),
        };
      })
    : report.findings;
  const cases = Array.isArray(report.cases)
    ? report.cases.map((c) => {
        if (!isRecord(c)) return c;
        const verdict = lower(c.verdict);
        return {
          ...c,
          verdict: typeof verdict === "string" ? (VERDICT_ALIASES[verdict] ?? verdict) : verdict,
        };
      })
    : report.cases;
  const comments = Array.isArray(report.comments)
    ? report.comments.map((c) => {
        if (!isRecord(c)) return c;
        const verdict = lower(c.verdict);
        return {
          ...c,
          verdict: typeof verdict === "string" ? (COMMENT_VERDICT_ALIASES[verdict] ?? verdict) : verdict,
        };
      })
    : report.comments;
  return {
    ...report,
    ...(report.cases !== undefined ? { cases } : {}),
    ...(report.comments !== undefined ? { comments } : {}),
    round: toInt(report.round ?? round),
    reviewer: lower(report.reviewer ?? kind),
    findings,
  };
}

/** Downgrades every blocker or major finding without a concrete failure scenario to minor (PRD §7.5). */
export function normalizeReport(report: Report): Report {
  return {
    ...report,
    findings: report.findings.map((f) =>
      f.severity !== "minor" && !f.failureScenario?.trim() ? { ...f, severity: "minor" } : f,
    ),
  };
}

// Must match `NOT_PERFORMED` in agents/tester.ts (importing it would make an import cycle).
const NOT_PERFORMED_PREFIX = "live test not performed";

/** Why a tester report does not cover the plan (PRD 05 §7.4); empty when it does. */
export function checkPlanCases(report: Report, plan: TestPlan): string[] {
  if (report.notes?.some((n) => n.startsWith(NOT_PERFORMED_PREFIX))) return [];
  const cases = report.cases ?? [];
  const planIds = new Set(plan.cases.map((c) => c.id));
  const count = new Map<string, number>();
  for (const c of cases) count.set(c.id, (count.get(c.id) ?? 0) + 1);
  const missing = plan.cases.filter((c) => !count.has(c.id)).map((c) => c.id);
  const unknown = [...count.keys()].filter((id) => !planIds.has(id));
  const twice = [...count].filter(([, n]) => n > 1).map(([id]) => id);
  const noEvidence = [...new Set(cases.filter((c) => c.verdict !== "pass" && !c.evidence?.trim()).map((c) => c.id))];
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`the report has no verdict for case(s) ${missing.join(", ")}`);
  if (unknown.length > 0) problems.push(`the report has verdicts for unknown case(s) ${unknown.join(", ")}`);
  if (twice.length > 0) problems.push(`case(s) ${twice.join(", ")} are reported more than once`);
  if (noEvidence.length > 0)
    problems.push(`case(s) ${noEvidence.join(", ")} have a fail or blocked verdict without evidence`);
  return problems;
}

/** Why a code report does not give every open comment exactly one verdict with evidence; empty when it does. */
export function checkCommentVerdicts(report: Report, comments: readonly { id: string }[]): string[] {
  const verdicts = report.comments ?? [];
  const ids = new Set(comments.map((c) => c.id));
  const count = new Map<string, number>();
  for (const v of verdicts) count.set(v.id, (count.get(v.id) ?? 0) + 1);
  const missing = comments.filter((c) => !count.has(c.id)).map((c) => c.id);
  const unknown = [...count.keys()].filter((id) => !ids.has(id));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`the report has no verdict for comment(s) ${missing.join(", ")}`);
  if (unknown.length > 0) problems.push(`unknown comment id(s) ${unknown.join(", ")}`);
  for (const [id, n] of count) if (n > 1) problems.push(`comment ${id} has two verdicts`);
  const noEvidence = [...new Set(verdicts.filter((v) => ids.has(v.id) && !v.evidence?.trim()).map((v) => v.id))];
  for (const id of noEvidence) problems.push(`comment ${id} has no evidence`);
  return problems;
}

/** Counts the open findings (`open` or `not_fixed`) by severity; findings a re-review marked `fixed` are skipped. */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0 };
  for (const f of findings) if (f.status !== "fixed") counts[f.severity]++;
  return counts;
}

/** Counts the findings a re-review marked `fixed`. */
export const countFixed = (findings: readonly Finding[]): number => findings.filter((f) => f.status === "fixed").length;

export interface PlanStats { total: number; passed: number; failed: number; blocked: number }

/** Counts of a tester report's test plan verdicts; undefined when the report has no cases. */
export function planStats(report: Report | undefined): PlanStats | undefined {
  const cases = report?.cases;
  if (!cases || cases.length === 0) return undefined;
  const count = (v: CaseResult["verdict"]): number => cases.filter((c) => c.verdict === v).length;
  return { total: cases.length, passed: count("pass"), failed: count("fail"), blocked: count("blocked") };
}

/**
 * Unresolved blocker and major findings: the ones that keep the review loop going (PRD §7.6). A previous finding the
 * reviewer verified as `not_fixed` is still open; only `fixed` resolves one.
 */
export const openBlocking = (report: Report): Finding[] =>
  report.findings.filter((f) => f.status !== "fixed" && f.severity !== "minor");

export const PLAN_PREFIX = "plan-";
export const planFindingId = (caseId: string): string => `${PLAN_PREFIX}${caseId}`;

/**
 * Applies the test plan to a tester report (PRD 05 §6): fills case titles/priorities, drops unknown cases,
 * replaces `plan-*` findings with ones made from the verdicts. `previous` is the previous round's tester report.
 */
export function applyTestPlan(report: Report, plan: TestPlan, previous?: Report): Report {
  const own = report.findings.filter((f) => !f.id.startsWith(PLAN_PREFIX));
  const note = report.notes?.find((n) => n.startsWith(NOT_PERFORMED_PREFIX));
  if (note) {
    const cases = plan.cases.map((c) => ({
      id: c.id,
      verdict: "blocked" as const,
      evidence: note,
      title: c.title,
      priority: c.priority,
    }));
    // Nothing was verified: previous plan findings that are not fixed stay open, as ordinary findings do.
    const planIds = new Set(plan.cases.map((c) => planFindingId(c.id)));
    const carried = (previous?.findings ?? []).filter(
      (f) => f.id.startsWith(PLAN_PREFIX) && planIds.has(f.id) && f.status !== "fixed",
    );
    return { ...report, findings: [...own, ...carried], cases };
  }
  const reported = new Map((report.cases ?? []).map((c) => [c.id, c]));
  const wasFailing = new Map(
    (previous?.findings ?? [])
      .filter((f) => f.id.startsWith(PLAN_PREFIX) && (f.status === "open" || f.status === "not_fixed"))
      .map((f) => [f.id, f]),
  );
  const cases: CaseResult[] = [];
  const planFindings: Finding[] = [];
  for (const c of plan.cases) {
    const r = reported.get(c.id);
    if (!r) continue;
    cases.push({ ...r, title: c.title, priority: c.priority });
    const id = planFindingId(c.id);
    const before = wasFailing.get(id);
    const evidence = r.evidence?.trim() ? r.evidence : (before?.failureScenario ?? `case ${c.id} is ${r.verdict}`);
    if (r.verdict === "pass") {
      if (before)
        planFindings.push({ ...before, description: c.title, failureScenario: evidence, status: "fixed" });
      continue;
    }
    planFindings.push({
      id,
      severity: r.verdict === "fail" && c.priority === "must" ? "blocker" : "major",
      description: c.title,
      failureScenario: evidence,
      status: before ? "not_fixed" : "open",
    });
  }
  return { ...report, findings: [...own, ...planFindings], cases };
}

/** Markdown rendering of a report, for the TUI. */
export function renderMarkdown(report: Report): string {
  const title = report.reviewer === "code" ? "Code review" : "Live test";
  const counts = countBySeverity(report.findings);
  const fixed = countFixed(report.findings);
  const countsLine = SEVERITIES.map((s) => `${counts[s]} ${s}`).join(", ") + (fixed > 0 ? ` (${fixed} fixed)` : "");
  const out = [`# ${title} — round ${report.round}`, "", countsLine, ""];
  if (report.summary) out.push(report.summary, "");
  for (const note of report.notes ?? []) out.push(`> ${note}`, "");
  for (const severity of SEVERITIES) {
    const findings = report.findings.filter((f) => f.severity === severity);
    if (findings.length === 0) continue;
    out.push(`## ${severity[0]!.toUpperCase()}${severity.slice(1)}`, "");
    for (const f of findings) {
      const where = f.file ? ` \`${f.file}${f.line !== undefined ? `:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}` : ""}\`` : "";
      out.push(`- **${f.id}** (${f.status})${where}: ${f.description}`);
      if (f.failureScenario) out.push(`  - Failure scenario: ${f.failureScenario}`);
      if (f.suggestedFix) out.push(`  - Suggested fix: ${f.suggestedFix}`);
    }
    out.push("");
  }
  if (report.cases) {
    out.push("## Test plan", "");
    for (const c of report.cases) out.push(`- ${c.id} (${c.priority ?? "?"}) ${c.verdict}: ${c.title ?? ""}`);
    out.push("");
  }
  return out.join("\n");
}

/** The prompt line that tells a reviewer where to write its report; the fake provider parses it back. */
export const reportPathLine = (file: string): string => `Write the JSON report to this absolute path: \`${file}\``;
export const summaryPathLine = (file: string): string => `Write the JSON summary to this absolute path: \`${file}\``;
export const SUMMARY_PATH_PATTERN = /Write the JSON summary to this absolute path: `([^`]+)`/;
export const REPORT_PATH_PATTERN = /Write the JSON report to this absolute path: `([^`]+)`/;

/** Reads a report file back; `undefined` unless it exists, matches the schema and belongs to `round` and `kind`. */
export async function readReport(file: string, round: number, kind: ReviewerKind): Promise<Report | undefined> {
  let raw: unknown;
  try {
    raw = coerceReport(parseReportText(await readFile(file, "utf8")), round, kind);
  } catch {
    return undefined;
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success || parsed.data.round !== round || parsed.data.reviewer !== kind) return undefined;
  return normalizeReport(parsed.data);
}
