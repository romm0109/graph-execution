import path from "node:path";
import { Box, Text } from "ink";
import { THEME } from "./theme.js";
import type { RunEnd, TargetMerge } from "../runner/events.js";
import { countBySeverity, type Finding, openBlocking, type Report, SEVERITIES } from "../review/report.js";

export interface SummarySection {
  heading?: string;
  lines: string[];
}

export interface SummaryContent {
  title: string;
  color: "green" | "yellow" | "red";
  sections: SummarySection[];
}

const REVIEWER_NAME: Record<Report["reviewer"], string> = { code: "code review", tester: "live test" };

const where = (f: Finding): string => (f.file ? ` ${f.file}${f.line !== undefined ? `:${f.line}` : ""}` : "");
const findingLine = (report: Report, f: Finding): string =>
  `- [${REVIEWER_NAME[report.reviewer]}] ${f.id} (${f.severity})${where(f)}: ${f.description}`;

/** The findings table: one row per report with its counts by severity. */
function findingsTable(reports: readonly Report[]): string[] {
  const width = Math.max(...Object.values(REVIEWER_NAME).map((n) => n.length)) + 2;
  const row = (name: string, cells: readonly (string | number)[]): string =>
    `${name.padEnd(width)}${cells.map((c) => String(c).padStart(9)).join("")}`.trimEnd();
  return [
    row("", SEVERITIES),
    ...reports.map((r) => {
      const counts = countBySeverity(r.findings);
      return row(REVIEWER_NAME[r.reviewer], SEVERITIES.map((s) => counts[s]));
    }),
  ];
}

/**
 * The end-of-run summary (PRD §7.9, §7.11) as text: what happened, the branch, the last review's findings by severity,
 * the minors and the tester's notes, then the next steps for the exit code. Shared by the Ink and the plain UI.
 */
export function summaryContent(end: RunEnd): SummaryContent {
  const { runId, branch, exitCode, reports } = end;
  const open = reports.flatMap((r) => openBlocking(r).map((f) => findingLine(r, f)));
  const minors = reports.flatMap((r) => r.findings.filter((f) => f.severity === "minor").map((f) => findingLine(r, f)));
  const notes = reports.flatMap((r) => r.notes ?? []);
  const reportsDir = path.join(end.runDir, "reports");

  const { merge } = end;
  const title =
    exitCode === 0
      ? `Run ${runId} finished: no open blocker or major finding${merge?.ok ? `, changes applied to ${merge.target}` : ""}`
      : exitCode === 1
        ? `Run ${runId} finished with ${open.length} open blocker/major finding(s) after ${end.fixPasses} fix pass(es)`
        : `Run ${runId} aborted at ${end.abort?.step ?? "run"}${end.abort ? `: ${end.abort.message}` : ""}`;
  const status = exitCode === 0 ? "clean" : exitCode === 1 ? "review loop exhausted" : "aborted";

  const sections: SummarySection[] = [{ lines: [`branch ${branch}`, `exit code ${exitCode} (${status})`] }];
  if (merge?.ok) {
    sections.push({ heading: `${APPLIED} ${merge.target}, nothing committed`, lines: changeLines(merge) });
  } else if (merge) sections.push({ heading: `Not applied to ${merge.target}`, lines: [merge.reason ?? "unknown reason"] });
  if (reports.length > 0) {
    sections.push({ heading: `Findings of the last review (round ${reports[0]!.round})`, lines: findingsTable(reports) });
  } else sections.push({ heading: "Findings", lines: ["no review has run yet"] });
  if (open.length > 0) sections.push({ heading: "Open blockers and majors", lines: open });
  if (reports.length > 0) sections.push({ heading: "Minor findings", lines: minors.length > 0 ? minors : ["none"] });
  if (notes.length > 0) sections.push({ heading: "Notes", lines: notes.map((n) => `- ${n}`) });

  const next =
    exitCode === 0 && merge?.ok
      ? [
          "review the changes: git diff (or your editor's diff view)",
          "keep them: git commit -a (the message lists the run's commits)",
          "drop them: git reset --hard (also drops anything you changed since)",
          `the result also stays on ${branch}; reports and agent logs: ${end.runDir}`,
        ]
      : exitCode === 0
      ? [
          `inspect the commits: git log ${branch}`,
          `bring it into your branch: git merge --squash --no-commit ${branch}`,
          `reports and agent logs: ${end.runDir}`,
        ]
      : exitCode === 1
        ? [
            `read the open findings in ${reportsDir}`,
            `inspect the commits: git log ${branch}`,
            `fix the remaining findings on ${branch} before merging it: git merge --no-ff ${branch}`,
          ]
        : [
            `resume the run: ${end.abort?.hint ?? `graph-execution --resume --run ${runId}`}`,
            `state, worktrees and logs are kept in ${end.runDir}`,
            `inspect what was merged so far: git log ${branch}`,
          ];
  sections.push({ heading: "Next steps", lines: next.map((l) => `- ${l}`) });
  return { title, color: exitCode === 0 ? "green" : exitCode === 1 ? "yellow" : "red", sections };
}

/** Start of the heading of the applied changes; their lines are drawn colored. */
const APPLIED = "Applied as uncommitted changes to";

const MAX_FILES = 25;
const MAX_COMMITS = 10;

/** What a merge brought in: one line per file with its line counts, a total, then the commits. */
function changeLines(merge: TargetMerge): string[] {
  if (merge.files.length === 0) return ["no file changed"];
  const width = Math.max(...merge.files.map((f) => `+${f.added}`.length));
  const out = merge.files.slice(0, MAX_FILES).map((f) => `${`+${f.added}`.padStart(width)} -${String(f.deleted).padEnd(4)} ${f.path}`);
  if (merge.files.length > MAX_FILES) out.push(`… and ${merge.files.length - MAX_FILES} more file(s)`);
  const added = merge.files.reduce((n, f) => n + f.added, 0);
  const deleted = merge.files.reduce((n, f) => n + f.deleted, 0);
  out.push(`${merge.files.length} file(s) changed, +${added} -${deleted}`);
  if (merge.commits.length > 0) {
    out.push("", `${merge.commits.length} commit(s):`, ...merge.commits.slice(0, MAX_COMMITS).map((c) => `  ${c}`));
    if (merge.commits.length > MAX_COMMITS) out.push(`  … and ${merge.commits.length - MAX_COMMITS} more`);
  }
  return out;
}

/** The summary as plain lines, for the non-TTY output. */
export function summaryLines(end: RunEnd): string[] {
  const { title, sections } = summaryContent(end);
  const out = [title];
  for (const section of sections) {
    if (section.heading) out.push("", `${section.heading}:`);
    out.push(...section.lines.map((l) => (section.heading ? `  ${l}` : l)));
  }
  return out;
}

const SUMMARY_COLOR: Record<SummaryContent["color"], string> = { green: THEME.ok, yellow: THEME.warn, red: THEME.bad };

/** Colors a change line: added counts green, deleted red. */
function ChangeLine({ line }: { line: string }) {
  const m = /^(\s*\+\d+) (-\d+\s*) (.*)$/.exec(line);
  if (!m) return <Text color={THEME.text}>{line}</Text>;
  return (
    <Text>
      <Text color={THEME.ok}>{m[1]}</Text> <Text color={THEME.bad}>{m[2]}</Text> <Text color={THEME.text}>{m[3]}</Text>
    </Text>
  );
}

/** The final summary screen, shown in place of the live tail once the run is over. */
export function Summary({ end }: { end: RunEnd }) {
  const { title, color, sections } = summaryContent(end);
  const accent = SUMMARY_COLOR[color];
  return (
    <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1}>
      <Text color={accent} bold>
        {`${color === "green" ? "✔" : color === "yellow" ? "▲" : "✖"} ${title}`}
      </Text>
      {sections.map((section, i) => (
        <Box key={i} flexDirection="column" marginTop={section.heading ? 1 : 0}>
          {section.heading ? (
            <Text>
              <Text color={THEME.accent}>▍</Text>
              <Text color={THEME.text} bold>
                {section.heading}
              </Text>
            </Text>
          ) : null}
          {section.lines.map((line, j) =>
            section.heading?.startsWith(APPLIED) ? (
              <ChangeLine key={j} line={line} />
            ) : (
              <Text key={j} color={section.heading ? THEME.text : THEME.muted}>
                {line}
              </Text>
            ),
          )}
        </Box>
      ))}
    </Box>
  );
}
