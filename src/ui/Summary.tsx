import path from "node:path";
import { Box, Text } from "ink";
import { THEME } from "./theme.js";
import type { RunEnd, TargetMerge } from "../runner/events.js";
import { countBySeverity, type Finding, openBlocking, type PlanStats, planStats, type Report, SEVERITIES } from "../review/report.js";

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

export function planLine(s: PlanStats): string {
  const extra = [s.failed > 0 ? `${s.failed} failed` : "", s.blocked > 0 ? `${s.blocked} blocked` : ""].filter(Boolean);
  return `Test plan: ${s.passed}/${s.total} passed${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
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
      : exitCode === 4
        ? `Run ${runId} finished but UNREVIEWED: the code review was not performed${merge && !merge.ok ? `; changes not applied to ${merge.target}` : ""}`
      : exitCode === 1
        ? `Run ${runId} finished with ${open.length} open blocker/major finding(s) after ${end.fixPasses} fix pass(es)`
        : `Run ${runId} aborted at ${end.abort?.step ?? "run"}${end.abort ? `: ${end.abort.message}` : ""}`;
  const status = exitCode === 0 ? "clean" : exitCode === 1 ? "review loop exhausted" : exitCode === 4 ? "unreviewed" : "aborted";

  const sections: SummarySection[] = [{ lines: [`branch ${branch}`, `exit code ${exitCode} (${status})`] }];
  if (merge?.ok) {
    sections.push({ heading: `${APPLIED} ${merge.target}, nothing committed`, lines: changeLines(merge) });
  } else if (merge) sections.push({ heading: `Not applied to ${merge.target}`, lines: [merge.reason ?? "unknown reason"] });
  if (end.human?.decision === "apply" && end.human.openFindings > 0) {
    sections.push({ lines: [`applied with ${end.human.openFindings} open finding(s)`] });
  } else if (end.human?.decision === "drop") sections.push({ lines: [`dropped — result kept on ${branch}`] });
  if (reports.length > 0) {
    sections.push({ heading: `Findings of the last review (round ${reports[0]!.round})`, lines: findingsTable(reports) });
  } else sections.push({ heading: "Findings", lines: ["no review has run yet"] });
  const plan = planStats(reports.find((r) => r.reviewer === "tester"));
  if (plan) sections.push({ lines: [planLine(plan)] });
  if (open.length > 0) sections.push({ heading: "Open blockers and majors", lines: open });
  if (reports.length > 0) sections.push({ heading: "Minor findings", lines: minors.length > 0 ? minors : ["none"] });
  if (notes.length > 0) sections.push({ heading: "Notes", lines: notes.map((n) => `- ${n}`) });
  if (end.loopStops?.length) {
    sections.push({ heading: "Loop stops", lines: end.loopStops.map((s) => `${s.label}: ${s.why}`) });
  }

  const next =
    exitCode === 0 && merge?.ok
      ? [
          ...(merge.conflicts?.length
            ? [`resolve the conflicts in ${merge.conflicts.map((c) => shellPath(c)).join(", ")}, then git add them`]
            : []),
          "review the changes in your editor's source control view (or git status and git diff)",
          "keep them: commit as usual, new files included (the prepared message lists the run's commits)",
          merge.backup
            ? `drop them and get back exactly what you had: ${dropCommand(merge)}`
            : `drop them: ${dropCommand(merge)} (also drops anything you changed in those files since)`,
          `the result also stays on ${branch}; reports and agent logs: ${end.runDir}`,
        ]
      : exitCode === 0
      ? [
          `inspect the commits: git log ${branch}`,
          `bring it into your branch: git merge --squash --no-commit ${branch}`,
          `reports and agent logs: ${end.runDir}`,
        ]
      : exitCode === 4
        ? [
            `review ${branch} yourself first: git log ${branch}`,
            `then bring it into your branch: git merge --squash --no-commit ${branch}`,
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
  return { title, color: exitCode === 0 ? "green" : exitCode === 1 || exitCode === 4 ? "yellow" : "red", sections };
}

/** Start of the heading of the applied changes; their lines are drawn colored. */
const APPLIED = "Applied as uncommitted changes to";

const MAX_FILES = 25;
const MAX_COMMITS = 10;

/** What the run left in the checkout: one line per file with its line counts and new files marked, then the commits. */
function changeLines(merge: TargetMerge): string[] {
  const head: string[] = [];
  if (merge.backup) head.push("your own uncommitted changes were kept and merged in; a backup is in git stash list");
  if (merge.conflicts?.length) {
    head.push(`${merge.conflicts.length} file(s) with conflicts to resolve:`, ...merge.conflicts.map((c) => `  ${c}`));
  }
  if (head.length > 0 && merge.files.length > 0) head.push("");
  if (merge.files.length === 0) return head.length > 0 ? head : ["no file changed"];
  return [...head, ...fileLines(merge)];
}

function fileLines(merge: TargetMerge): string[] {
  const width = Math.max(...merge.files.map((f) => `+${f.added}`.length));
  const out = merge.files
    .slice(0, MAX_FILES)
    .map((f) => `${`+${f.added}`.padStart(width)} -${String(f.deleted).padEnd(4)} ${f.path}${f.isNew ? " (new)" : ""}`);
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

/**
 * Quotes a path for a shell command when it needs it. Windows: double quotes, which cmd and PowerShell both read
 * (a Windows path cannot contain `"`). Elsewhere: POSIX single quotes.
 */
export const shellPath = (p: string, platform: NodeJS.Platform = process.platform): string =>
  /^[\w./@+-]+$/.test(p) ? p : platform === "win32" ? `"${p}"` : `'${p.replace(/'/g, "'\\''")}'`;

/**
 * How to drop what the run left: restore the changed files, delete exactly the new ones and nothing else. With
 * conflicts or the user's own changes merged in, everything is reset and the user's changes are applied back from
 * their backup, staged as they were.
 */
function dropCommand(merge: TargetMerge): string {
  const created = merge.files.filter((f) => f.isNew).map((f) => shellPath(f.path));
  const clean = created.length === 0 ? "" : ` && git clean -f -- ${created.join(" ")}`;
  if (!merge.backup && !merge.conflicts?.length) return `git restore .${clean}`;
  const restore = merge.backup ? ` && git stash apply --index ${merge.backup.slice(0, 12)}` : "";
  return `git reset --hard${clean}${restore}`;
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
