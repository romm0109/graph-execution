import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDetachedWorktree, removeWorktreeIfPresent } from "../git/git.js";
import type { MergeLock } from "../git/mutex.js";
import type { AgentRole, Provider } from "../providers/types.js";
import type { TestPlan } from "../graph/testPlan.js";
import type { ReviewerContext } from "../review/context.js";
import { type Comment, commentWhere, parseSuggestion, REMOVED_NOTE } from "../review/human.js";
import {
  checkCommentVerdicts,
  checkPlanCases,
  coerceReport,
  normalizeReport,
  parseReportText,
  type Report,
  type ReviewerKind,
  reportPathLine,
  reportSchema,
} from "../review/report.js";
import { AbortRunError, InterruptedError, RetriesExhaustedError } from "../state/errors.js";
import { runCommands } from "../validate/commands.js";
import { type AttemptFailure, type CheckResult, withRetries } from "./retry.js";

export interface CodeReviewerOptions {
  /** 0-based review round; the report goes to `reports/round<N>/code.json`. */
  round: number;
  provider: Provider;
  repo: string;
  /** `.graph-execution/<run-id>` */
  runDir: string;
  /** Head of `graph/<run-id>` the reviewer's worktree is created at. */
  head: string;
  context: ReviewerContext;
  /** The previous round's code report, verified first from the second round on. */
  previous?: Report;
  /** The open human review comments; the report must give a verdict for each. */
  comments?: readonly Comment[];
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

export const reviewReportPath = (runDir: string, round: number, kind: ReviewerKind): string =>
  path.join(runDir, "reports", `round${round}`, `${kind}.json`);

export const codeReportPath = (runDir: string, round: number): string => reviewReportPath(runDir, round, "code");

export const fence = (text: string): string => {
  // A fence longer than any backtick run inside the text, so embedded fences cannot close it.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text.trimEnd()}\n${ticks}`;
};

/** The previous report without the `human-*` findings: the `comments` verdicts cover them. */
function withoutHumanFindings(report: Report): Report {
  return { ...report, findings: report.findings.filter((f) => !f.id.startsWith("human-")) };
}

export function codeReviewerPrompt(
  ctx: ReviewerContext,
  round: number,
  reportPath: string,
  previous?: Report,
  comments: readonly Comment[] = [],
): string {
  const out = [
    "You are the code reviewer of a change set built by AI coding agents from the specification below.",
    "Judge the result against what the specification asks for.",
    "",
    "## Specification",
    "",
    ctx.spec.trimEnd(),
    "",
    "## Tasks",
    "",
    `The change set was built from the task files (JSON) in \`${ctx.tasksDir}\`. You may read them if useful.`,
    "",
    "## Diff against the starting commit",
    "",
    ctx.diff.trim() === "" ? "(empty diff)" : fence(ctx.diff),
    "",
  ];
  if (ctx.reviewMd !== undefined) {
    out.push("## Review rules (REVIEW.md)", "", ctx.reviewMd.trimEnd(), "");
  }
  out.push(
    "## Instructions",
    "",
    "- Review the diff for bugs, security problems and correctness against the specification" +
      (ctx.reviewMd !== undefined ? ", and for violations of the review rules above." : "."),
    "- You may read any file in the current directory, which is a checkout of the integrated result, and run commands.",
    "- Do NOT modify, create or delete code files, and do not commit: this checkout is thrown away after the review.",
    "- Every blocker or major finding needs a concrete `failureScenario` (inputs or state that lead to a wrong",
    "  result or a crash). Findings without one are downgraded to minor.",
    '- Give every finding a unique `id` (F1, F2, ...) and `status: "open"`.',
  );
  if (previous) {
    out.push(
      "- First verify each finding of the previous report below: keep its `id` and set its `status` to `fixed` or",
      "  `not_fixed`. Then add only NEW blocker or major findings, no new minor ones.",
      "",
      "## Previous report",
      "",
      fence(JSON.stringify(comments.length > 0 ? withoutHumanFindings(previous) : previous, null, 2)),
    );
  }
  if (ctx.fixerSummary !== undefined) {
    out.push(
      "",
      "## Fixer's commit summary",
      "",
      "What the fixer says it changed since the previous report:",
      "",
      fence(ctx.fixerSummary),
    );
  }
  if (comments.length > 0) {
    out.push("", "## Human review comments", "", "The user asked for these changes. Check each one against the code:", "");
    for (const c of comments) {
      out.push(`- **${c.id}**${commentWhere(c)}: ${[c.body, ...c.followUps.map((f) => `Follow-up: ${f}`)].join("\n  ")}`);
      if (c.side === "old" && c.startLine) out.push(`  ${REMOVED_NOTE}`);
      if (c.snippet) out.push(`  Code:`, fence(c.snippet));
      const suggestion = parseSuggestion(c.body);
      if (suggestion !== undefined) {
        out.push("  Suggested replacement (addressed only if the code at these lines now matches it, or the fixer's note explains a better equivalent):", fence(suggestion));
      }
    }
    out.push(
      "",
      'For every comment above, report `comments: [{ id, verdict: "addressed" | "not_addressed", evidence }]`, where',
      "evidence points at the code (file:line) that addresses it, or says what is missing.",
    );
  }
  const example = {
    round,
    reviewer: "code",
    summary: "...",
    findings: [
      {
        id: "F1",
        severity: "blocker|major|minor",
        file: "src/a.ts",
        line: 42,
        description: "...",
        failureScenario: "...",
        suggestedFix: "...",
        status: "open",
      },
    ],
    ...(comments.length > 0
      ? { comments: [{ id: comments[0]!.id, verdict: "addressed|not_addressed", evidence: "src/a.ts:42 ..." }] }
      : {}),
  };
  out.push(
    "",
    "## Report",
    "",
    reportPathLine(reportPath),
    "(it is outside the current directory; create it there and nowhere else).",
    `It must be a JSON object of this shape, with \`round\` ${round} and \`reviewer\` "code"; \`file\`, \`line\`,`,
    "`summary`, `failureScenario` and `suggestedFix` are optional, `findings` may be empty:",
    "",
    fence(JSON.stringify(example, null, 2)),
    "",
  );
  return out.join("\n");
}

export interface ReviewAgentOptions {
  kind: ReviewerKind;
  round: number;
  provider: Provider;
  repo: string;
  runDir: string;
  /** The integration branch head the throwaway worktree is created at. */
  head: string;
  prompt: string;
  /** The test plan the tester must report a verdict for; only used for `kind: "tester"`. */
  plan?: TestPlan;
  /** The open human review comments the code reviewer must give a verdict for; only used for `kind: "code"`. */
  comments?: readonly Comment[];
  setup: readonly string[];
  /** The run's lock on the worktree list: concurrent `git worktree` commands race on `.git/worktrees`. */
  withLock?: MergeLock;
  attempts?: number;
  signal: AbortSignal;
  hint: string;
  model?: string;
  /** Called before attempt `attempt` starts, with the previous attempt's failure on a retry. */
  onAttempt?: (attempt: number, previous?: AttemptFailure) => void;
  log?: (line: string) => void;
}

const ROLE: Record<ReviewerKind, AgentRole> = {
  code: "reviewer",
  tester: "tester",
};
const STEP: Record<ReviewerKind, string> = {
  code: "code review",
  tester: "live test",
};

/** The output label of a reviewer's agent, e.g. `code-r0`. */
export const reviewerLabel = (kind: ReviewerKind, round: number): string => `${kind}-r${round}`;

export const reviewStep = (kind: ReviewerKind, round: number): string => `${STEP[kind]} round ${round}`;

/**
 * Runs one reviewer (PRD §7.5) in its own throwaway worktree, detached at `head`, with `setup` run in it. The report
 * is written outside that worktree, validated against the report schema and stored normalized; a crash or an invalid
 * or missing report is retried. The worktree is always removed afterwards. Checking that the integration branch head
 * did not move is the caller's job, once every reviewer of the round has finished. Returns the normalized report.
 */
export async function runReviewAgent(opts: ReviewAgentOptions): Promise<Report> {
  const { kind, round, repo, signal, hint } = opts;
  const log = opts.log ?? (() => undefined);
  const attempts = opts.attempts ?? 3;
  const label = reviewerLabel(kind, round);
  const step = reviewStep(kind, round);
  const worktree = path.join(opts.runDir, "worktrees", `review-${label}`);
  const reportPath = reviewReportPath(opts.runDir, round, kind);
  const withLock = opts.withLock ?? (<T>(fn: () => Promise<T>) => fn());

  /** The text of the last invalid report, shown to the next attempt so it can rewrite it instead of starting over. */
  let invalidText: string | undefined;
  /** The last report that was schema-valid but did not cover the test plan. */
  let lastPlanReport: Report | undefined;
  /** The last report that was schema-valid but did not cover the human review comments. */
  let lastCommentReport: Report | undefined;
  const check = async (exitCode: number): Promise<CheckResult<Report>> => {
    invalidText = undefined;
    lastPlanReport = undefined;
    lastCommentReport = undefined;
    if (exitCode !== 0)
      return {
        ok: false,
        reason: {
          class: "crash",
          message: `${ROLE[kind]} exited with code ${exitCode}`,
        },
      };
    if (!existsSync(reportPath)) {
      return {
        ok: false,
        reason: {
          class: "invalid_report",
          message: `no report was written to ${reportPath}`,
        },
      };
    }
    const text = await readFile(reportPath, "utf8");
    let raw: unknown;
    try {
      raw = coerceReport(parseReportText(text), round, kind);
    } catch (err) {
      invalidText = text;
      return {
        ok: false,
        reason: {
          class: "invalid_report",
          message: `the report is not valid JSON: ${(err as Error).message}`,
        },
      };
    }
    const parsed = reportSchema.safeParse(raw);
    if (!parsed.success) {
      invalidText = text;
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return {
        ok: false,
        reason: {
          class: "invalid_report",
          message: `the report does not match the schema: ${issues}`,
        },
      };
    }
    if (parsed.data.round !== round || parsed.data.reviewer !== kind) {
      return {
        ok: false,
        reason: {
          class: "invalid_report",
          message: `the report must have round ${round} and reviewer "${kind}"`,
        },
      };
    }
    const report = normalizeReport(parsed.data);
    if (kind === "tester" && opts.plan) {
      const problems = checkPlanCases(report, opts.plan);
      if (problems.length > 0) {
        invalidText = text;
        lastPlanReport = report;
        return {
          ok: false,
          reason: { class: "invalid_report", message: problems.join("; ") },
        };
      }
    }
    if (kind === "code" && opts.comments?.length) {
      const problems = checkCommentVerdicts(report, opts.comments);
      if (problems.length > 0) {
        invalidText = text;
        lastCommentReport = report;
        return {
          ok: false,
          reason: { class: "invalid_report", message: problems.join("; ") },
        };
      }
    }
    return { ok: true, value: report };
  };

  let previousFailure: AttemptFailure | undefined;
  let report: Report;
  try {
    report = await withRetries({
      attempts,
      label: step,
      hint,
      signal,
      onAttempt: (attempt, previous) => {
        previousFailure = previous;
        if (previous) log(`${step}: ${previous.message}; retry ${attempt}/${attempts}`);
        else log(`${step}: running the ${kind === "code" ? "code reviewer" : "live tester"}`);
        opts.onAttempt?.(attempt, previous);
      },
      // Every attempt gets a fresh worktree and no stale report.
      prepare: async () => {
        await withLock(async () => {
          await removeWorktreeIfPresent(repo, worktree);
          await addDetachedWorktree(repo, worktree, opts.head);
        });
        await rm(reportPath, { force: true });
        await mkdir(path.dirname(reportPath), { recursive: true });
        await runSetup(worktree);
      },
      execute: async () => {
        const prompt = previousFailure ? `${opts.prompt}\n\n${retryNote(previousFailure, invalidText)}` : opts.prompt;
        // The provider runs the agent in its own process group and kills that group once the agent exits,
        // so servers the tester booted do not outlive it.
        const agent = opts.provider.run({
          role: ROLE[kind],
          prompt,
          cwd: worktree,
          signal,
          model: opts.model,
          label,
        });
        for await (const event of agent.events) {
          if (event.type === "output") log(`[${ROLE[kind]} ${label}] ${event.text.trimEnd()}`);
        }
        return (await agent.done).exitCode;
      },
      check,
    });
  } catch (err) {
    if (err instanceof RetriesExhaustedError && (lastPlanReport ?? lastCommentReport)) {
      err.lastReport = lastPlanReport ?? lastCommentReport;
    }
    throw err;
  } finally {
    await withLock(() => removeWorktreeIfPresent(repo, worktree));
  }

  // Stored normalized: findings downgraded to minor stay minor for the fixer and the summary.
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;

  async function runSetup(cwd: string): Promise<void> {
    if (opts.setup.length === 0) return;
    log(`${step}: running setup`);
    const result = await runCommands(opts.setup, cwd, signal);
    if (signal.aborted) throw new InterruptedError(`${step} was interrupted`, { step, hint });
    if (!result.ok) {
      log(result.output);
      throw new AbortRunError(`setup command \`${result.command}\` failed with exit code ${result.exitCode}`, {
        step,
        hint,
      });
    }
  }
}

/**
 * What a retry is told about the previous attempt: why it failed and, for a report that did not parse or match the
 * schema, its text, so the agent can rewrite the report from its findings rather than redo the whole review.
 */
export function retryNote(previous: AttemptFailure, invalidText?: string): string {
  const out = ["## Previous attempt", "", `Your previous attempt failed: ${previous.message}.`];
  if (previous.class === "invalid_report") {
    out.push(
      "Write the report again, as a single JSON object that matches the shape above exactly (no Markdown, no comments).",
    );
  }
  if (invalidText !== undefined && invalidText.trim() !== "") {
    out.push(
      "This is what it wrote; you may reuse its findings, just fix the format:",
      "",
      fence(invalidText.slice(0, 20_000)),
    );
  }
  return out.join("\n");
}

/** Runs the code reviewer (PRD §7.5); see `runReviewAgent`. */
export function runCodeReviewer(opts: CodeReviewerOptions): Promise<Report> {
  const reportPath = codeReportPath(opts.runDir, opts.round);
  return runReviewAgent({
    ...opts,
    kind: "code",
    prompt: codeReviewerPrompt(opts.context, opts.round, reportPath, opts.previous, opts.comments),
  });
}
