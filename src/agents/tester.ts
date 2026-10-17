import type { MergeLock } from "../git/mutex.js";
import type { AttemptFailure } from "./retry.js";
import type { Provider } from "../providers/types.js";
import type { ReviewerContext } from "../review/context.js";
import { type Report, reportPathLine } from "../review/report.js";
import { fence, reviewReportPath, runReviewAgent } from "./reviewer.js";

export interface LiveTesterOptions {
  /** 0-based review round; the report goes to `reports/round<N>/tester.json`. */
  round: number;
  provider: Provider;
  repo: string;
  /** `.graph-execution/<run-id>` */
  runDir: string;
  /** Head of `graph/<run-id>` the tester's worktree is created at. */
  head: string;
  context: ReviewerContext;
  /** The previous round's tester report, verified first from the second round on. */
  previous?: Report;
  /** The run's lock on the worktree list: concurrent `git worktree` commands race on `.git/worktrees`. */
  withLock?: MergeLock;
  /** The config's `setup` commands, run in the throwaway worktree. */
  setup: readonly string[];
  attempts?: number;
  signal: AbortSignal;
  hint: string;
  model?: string;
  /** Called before attempt `attempt` starts, with the previous attempt's failure on a retry. */
  onAttempt?: (attempt: number, previous?: AttemptFailure) => void;
  log?: (line: string) => void;
}

export const testerReportPath = (runDir: string, round: number): string => reviewReportPath(runDir, round, "tester");

/** The note prefix of a tester report whose live test could not run (PRD §7.5). */
export const NOT_PERFORMED = "live test not performed";

/** The live tester's prompt: spec, tasks folder, changed files and `TESTING.md`, never the diff (PRD §7.5). */
export function testerPrompt(ctx: ReviewerContext, round: number, reportPath: string, previous?: Report): string {
  const out = [
    "You are the live tester of a change set built by AI coding agents from the specification below.",
    "Run the result and check that it behaves as the specification asks.",
    "",
    "## Specification",
    "",
    ctx.spec.trimEnd(),
    "",
    "## Tasks",
    "",
    `The change set was built from the task files (JSON) in \`${ctx.tasksDir}\`. You may read them if useful.`,
    "",
    "## Changed files",
    "",
    "Files changed by the change set, as a hint for what to exercise:",
    "",
    ...(ctx.changedFiles.length === 0 ? ["(none)"] : ctx.changedFiles.map((f) => `- ${f}`)),
    "",
  ];
  if (ctx.testingMd !== undefined) {
    out.push("## How to test this app (TESTING.md)", "", ctx.testingMd.trimEnd(), "");
  }
  out.push(
    "## Instructions",
    "",
    ctx.testingMd !== undefined
      ? "- Follow TESTING.md above: boot the app as it describes, use its URLs, endpoints and credentials, run its checks."
      : "- There is no TESTING.md: work out how to boot the app from the README and the package scripts (best effort).",
    "- The current directory is a checkout of the integrated result; boot the app from here.",
    "- Exercise the behavior the specification asks for: call the API, or drive the UI with an available browser",
    "  automation tool.",
    "- Do NOT modify, create or delete code files, and do not commit: this checkout is thrown away after the test.",
    "- Stop every server or process you started before you finish. Anything left running is killed when you exit.",
    "- Every blocker or major finding needs a concrete `failureScenario` (the requests, inputs or steps and what went",
    "  wrong). Findings without one are downgraded to minor.",
    "- Give every finding a unique `id` (T1, T2, ...) and `status: \"open\"`.",
    `- If you cannot run the app at all, do not fail: add a note "${NOT_PERFORMED}: <reason>" to \`notes\` and`,
    "  report no findings.",
  );
  if (previous) {
    out.push(
      "- First verify each finding of the previous report below: keep its `id` and set its `status` to `fixed` or",
      "  `not_fixed`. Then add only NEW blocker or major findings, no new minor ones.",
      "",
      "## Previous report",
      "",
      fence(JSON.stringify(previous, null, 2)),
    );
  }
  if (ctx.fixerSummary !== undefined) {
    out.push("", "## Fixer's commit summary", "", "What the fixer says it changed since the previous report:", "", fence(ctx.fixerSummary));
  }
  const example = {
    round,
    reviewer: "tester",
    summary: "...",
    notes: ["..."],
    findings: [
      {
        id: "T1",
        severity: "blocker|major|minor",
        file: "src/a.ts",
        line: 42,
        description: "...",
        failureScenario: "...",
        suggestedFix: "...",
        status: "open",
      },
    ],
  };
  out.push(
    "",
    "## Report",
    "",
    reportPathLine(reportPath),
    "(it is outside the current directory; create it there and nowhere else).",
    `It must be a JSON object of this shape, with \`round\` ${round} and \`reviewer\` "tester"; \`file\`, \`line\`,`,
    "`summary`, `notes`, `failureScenario` and `suggestedFix` are optional, `findings` may be empty:",
    "",
    fence(JSON.stringify(example, null, 2)),
    "",
  );
  return out.join("\n");
}

/** Runs the live tester (PRD §7.5) in its own throwaway worktree; see `runReviewAgent`. */
export function runLiveTester(opts: LiveTesterOptions): Promise<Report> {
  const reportPath = testerReportPath(opts.runDir, opts.round);
  return runReviewAgent({ ...opts, kind: "tester", prompt: testerPrompt(opts.context, opts.round, reportPath, opts.previous) });
}
