import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { type FixerOptions, type FixerResult, fixerLabel, fixerSummaryPath, runFixer } from "../agents/fixer.js";
import type { AttemptFailure } from "../agents/retry.js";
import { reviewerLabel, reviewReportPath, reviewStep, runCodeReviewer } from "../agents/reviewer.js";
import { runLiveTester } from "../agents/tester.js";
import type { Config } from "../config/config.js";
import { currentHead, resetHard } from "../git/git.js";
import type { MergeLock } from "../git/mutex.js";
import type { Provider } from "../providers/types.js";
import { type PhaseChange, phaseLabel, type ReviewAgent, type RunEmitter } from "../runner/events.js";
import {
  AbortRunError,
  EXIT_REVIEW_FAILED,
  EXIT_SUCCESS,
  type ExitCode,
  InterruptedError,
  RetriesExhaustedError,
} from "../state/errors.js";
import { initialReviewState, type ReviewState } from "../state/state.js";
import { runCommands, writeValidationLog } from "../validate/commands.js";
import { buildReviewerContext } from "./context.js";
import {
  coerceReport,
  countBySeverity,
  normalizeReport,
  parseReportText,
  openBlocking,
  type Report,
  type ReviewerKind,
  reportSchema,
  SEVERITIES,
} from "./report.js";

export { EXIT_REVIEW_FAILED };

export interface ReviewPhaseOptions {
  provider: Provider;
  config: Config;
  repo: string;
  runDir: string;
  integrationWorktree: string;
  integrationBranch: string;
  startingCommit: string;
  specPath: string;
  tasksDir: string;
  signal: AbortSignal;
  hint: string;
  model?: string;
  log: (line: string) => void;
  /** The run's integration-worktree lock, held by the fixer while it works there. */
  withLock?: MergeLock;
  /** Where to start, saved by a previous process (PRD §7.8); the gate before round 0 when omitted. */
  progress?: ReviewState;
  /** Receives the phase, round, fix pass and agent events for the UI. */
  events?: RunEmitter;
  /** Called with every step change, to persist it before the step's side effects go on. */
  onProgress?: (progress: ReviewState) => Promise<void>;
}

export interface ReviewPhaseResult {
  exitCode: ExitCode;
  /** The last round's reports: the code reviewer's, then the live tester's. Minors stay in them for the summary. */
  reports: Report[];
  /** Every round's reports, round 0 first. */
  rounds: Report[][];
  /** Informational notes of the last round's reports, e.g. "live test not performed: ...", for the final summary. */
  notes: string[];
}

/**
 * The review phase, run once every task is merged (PRD §7.5, §7.6): the validation gate on the integration worktree,
 * then a review round, then up to `fixPasses` fix passes, each followed by a re-review. A review round runs the code
 * reviewer and the live tester in parallel, each in its own throwaway worktree with its own retries; once both have
 * finished, the integration branch head must be unchanged. A fix pass runs the fixer in the integration worktree,
 * then the validation gate, whose failures go back to the fixer for up to `validationRounds` rounds that do not
 * consume a fix pass. Exit code 0 as soon as a review has no open blocker or major finding (minors never trigger a
 * pass), 1 when the last re-review still has some; branch, worktrees and reports are kept either way.
 * Every step change goes through `onProgress`; given a saved `progress`, the phase continues from that step.
 */
export async function runReviewPhase(opts: ReviewPhaseOptions): Promise<ReviewPhaseResult> {
  const { log, config } = opts;
  let progress = opts.progress ?? initialReviewState();
  const save = async (next: ReviewState): Promise<void> => {
    progress = next;
    await opts.onProgress?.(next);
  };

  // Rounds finished before a resume are read back from their reports.
  const finished = progress.phase === "validate" ? 0 : progress.phase === "done" ? progress.round + 1 : progress.round;
  const rounds: Report[][] = [];
  for (let round = 0; round < finished; round++) rounds.push(await loadRound(opts.runDir, round));

  let shown: string | undefined;
  const showPhase = (change: PhaseChange): void => {
    if (phaseLabel(change) === shown) return;
    shown = phaseLabel(change);
    opts.events?.emit("phase:change", change);
  };

  for (;;) {
    const { phase, round } = progress;
    showPhase(phase === "review" || phase === "fix" ? { phase, round, fixPasses: config.fixPasses } : { phase });
    switch (progress.phase) {
      case "validate":
        await gate(opts, 0);
        await save({ phase: "review", round: 0, validationRounds: 0, reports: {} });
        break;
      case "review": {
        const round = progress.round;
        const after =
          round === 0 ? undefined : { previous: rounds[round - 1]!, fixerSummary: await readFixerSummaries(opts.runDir, round) };
        opts.events?.emit("review:start", { round });
        const reports = await reviewRound(opts, round, after, async (kind, file) => {
          if (progress.reports[kind] !== file) await save({ ...progress, reports: { ...progress.reports, [kind]: file } });
        });
        rounds.push(reports);
        opts.events?.emit("review:end", { round, reports });
        const open = reports.flatMap(openBlocking);
        if (open.length > 0 && round >= config.fixPasses) {
          log(
            `${open.length} open blocker/major finding(s) remain on ${opts.integrationBranch} after ${config.fixPasses} fix pass(es)`,
          );
        }
        if (open.length === 0 || round >= config.fixPasses) {
          await save({ phase: "done", round, validationRounds: 0, reports: progress.reports });
        } else {
          const fixBase = await revParse(opts.repo, opts.integrationBranch);
          await save({ phase: "fix", round: round + 1, validationRounds: 0, reports: {}, fixBase });
        }
        break;
      }
      case "fix": {
        const pass = progress.round;
        const reports = rounds[pass - 1]!;
        log(`${reports.flatMap(openBlocking).length} open blocker/major finding(s); fix pass ${pass}/${config.fixPasses}`);
        opts.events?.emit("fix:start", { pass, passes: config.fixPasses });
        await fixPass(opts, pass, reports, progress.fixBase, (validationRounds) => save({ ...progress, validationRounds }));
        opts.events?.emit("fix:end", { pass });
        await save({ phase: "review", round: pass, validationRounds: 0, reports: {} });
        break;
      }
      case "done": {
        const reports = rounds.at(-1)!;
        const notes = reports.flatMap((r) => r.notes ?? []);
        const exitCode = reports.flatMap(openBlocking).length === 0 ? EXIT_SUCCESS : EXIT_REVIEW_FAILED;
        return { exitCode, reports, rounds, notes };
      }
    }
  }
}

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

const REVIEWERS: readonly ReviewerKind[] = ["code", "tester"];

/** The note of a report whose reviewer ran out of attempts (PRD §7.5: like a live test that could not run). */
export const NOT_PERFORMED: Record<ReviewerKind, string> = {
  code: "code review not performed",
  tester: "live test not performed",
};

/** True when the code reviewer of `reports` gave up, so the result was not reviewed. */
export const codeReviewSkipped = (reports: readonly Report[]): boolean =>
  reports.some((r) => r.reviewer === "code" && (r.notes ?? []).some((n) => n.startsWith(NOT_PERFORMED.code)));
const AGENT: Record<ReviewerKind, ReviewAgent> = { code: "reviewer", tester: "tester" };

/** Reports an agent's attempts as `agent:start` and `agent:retry` events; pass it as the runner's `onAttempt`. */
const attemptEvents =
  (opts: ReviewPhaseOptions, agent: ReviewAgent, label: string) =>
  (attempt: number, previous?: AttemptFailure): void => {
    if (!previous) opts.events?.emit("agent:start", { agent, label });
    else opts.events?.emit("agent:retry", { agent, label, attempt, attempts: opts.config.attempts, reason: previous });
  };

/** Runs `fn` for the agent's node, ending it as done or failed. */
async function trackAgent<T>(opts: ReviewPhaseOptions, agent: ReviewAgent, label: string, fn: () => Promise<T>): Promise<T> {
  let ok = false;
  try {
    const result = await fn();
    ok = true;
    return result;
  } finally {
    opts.events?.emit("agent:end", { agent, label, ok });
  }
}

/** A finished round's reports, the code reviewer's then the live tester's. */
async function loadRound(runDir: string, round: number): Promise<Report[]> {
  const reports: Report[] = [];
  for (const kind of REVIEWERS) {
    const file = reviewReportPath(runDir, round, kind);
    const report = await readReport(file, round, kind);
    if (!report) throw new Error(`cannot resume the review: the report ${file} is missing or invalid`);
    reports.push(report);
  }
  return reports;
}

/** The commit summaries of fix pass `pass`, in order: the fixer's, then those of its validation fix rounds. */
async function readFixerSummaries(runDir: string, pass: number): Promise<string> {
  const summaries: string[] = [];
  for (let v: number | undefined = undefined; ; v = (v ?? 0) + 1) {
    const file = fixerSummaryPath(runDir, pass, v);
    if (!existsSync(file)) break;
    summaries.push((await readFile(file, "utf8")).trimEnd());
  }
  return summaries.join("\n\n");
}

/**
 * One review round: both reviewers in parallel; from round 1 on with the previous reports and the fixer's summary.
 * A reviewer whose valid report already exists (written before a resume) is not run again.
 */
async function reviewRound(
  opts: ReviewPhaseOptions,
  round: number,
  after: { previous: Report[]; fixerSummary: string } | undefined,
  onReport: (kind: ReviewerKind, file: string) => Promise<void>,
): Promise<Report[]> {  const { log, signal, hint } = opts;
  const context = await buildReviewerContext({
    specPath: opts.specPath,
    tasksDir: opts.tasksDir,
    repoRoot: opts.repo,
    startingCommit: opts.startingCommit,
    integrationWorktree: opts.integrationWorktree,
    ...(after ? { fixerSummary: after.fixerSummary } : {}),
  });
  if (round === 0) {
    if (context.reviewMd === undefined) log("no REVIEW.md at the repo root; the code reviewer applies general rules");
    if (context.testingMd === undefined) log("no TESTING.md at the repo root; the live tester works from the README and scripts");
  }

  const head = await revParse(opts.repo, opts.integrationBranch);
  const previous = (kind: Report["reviewer"]): Report | undefined => after?.previous.find((r) => r.reviewer === kind);
  const shared = {
    round,
    provider: opts.provider,
    repo: opts.repo,
    runDir: opts.runDir,
    head,
    context,
    setup: opts.config.setup,
    attempts: opts.config.attempts,
    signal,
    hint,
    model: opts.model,
    log,
    withLock: opts.withLock,
  };
  // Settled, not raced: a failing reviewer must not leave the other one running while the run aborts.
  const runOne = async (kind: ReviewerKind): Promise<Report> => {
    const file = reviewReportPath(opts.runDir, round, kind);
    const label = reviewerLabel(kind, round);
    try {
      return await trackAgent(opts, AGENT[kind], label, async () => {
      const existing = await readReport(file, round, kind);
      if (existing) {
        log(`${reviewStep(kind, round)}: reusing the existing report`);
        await onReport(kind, file);
        return existing;
      }
      const runner = kind === "code" ? runCodeReviewer : runLiveTester;
      const onAttempt = attemptEvents(opts, AGENT[kind], label);
      const report = await runner({ ...shared, previous: previous(kind), onAttempt });
      await onReport(kind, file);
      return report;
      });
    } catch (err) {
      if (!(err instanceof RetriesExhaustedError)) throw err;
      // A reviewer that keeps failing does not stop the run: its report says so, and the previous round's
      // unresolved findings stay open, so they still count.
      const report: Report = {
        round,
        reviewer: kind,
        notes: [`${NOT_PERFORMED[kind]}: ${err.message}`],
        findings: (previous(kind)?.findings ?? []).filter((f) => f.status !== "fixed"),
      };
      log(`${reviewStep(kind, round)}: giving up after ${opts.config.attempts} attempts; continuing without it`);
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      await onReport(kind, file);
      return report;
    }
  };
  const settled = await Promise.allSettled(REVIEWERS.map(runOne));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  const reports = settled.map((r) => (r as PromiseFulfilledResult<Report>).value);

  const moved = await revParse(opts.repo, opts.integrationBranch);
  if (moved !== head) {
    throw new AbortRunError(
      `${opts.integrationBranch} moved from ${head.slice(0, 12)} to ${moved.slice(0, 12)} during the review; reviewers must not change it`,
      { step: `review round ${round}`, hint },
    );
  }

  for (const report of reports) {
    const counts = countBySeverity(report.findings);
    const name = report.reviewer === "code" ? "code review" : "live test";
    log(`${name} round ${round}: ${SEVERITIES.map((s) => `${counts[s]} ${s}`).join(", ")}`);
  }
  for (const note of reports.flatMap((r) => r.notes ?? [])) log(`note: ${note}`);
  return reports;
}

/**
 * One fix pass (PRD §7.6): the fixer, then the validation gate; a failing gate goes back to the fixer for up to
 * `validationRounds` rounds, then the run aborts. The fixer's commit summaries are left in `reports/round<pass>/`.
 */
async function fixPass(
  opts: ReviewPhaseOptions,
  pass: number,
  reports: Report[],
  fixBase: string | undefined,
  onValidationRound: (round: number) => Promise<void>,
): Promise<void> {
  const { config, signal, hint } = opts;
  const withLock = opts.withLock ?? (<T>(fn: () => Promise<T>) => fn());
  // A pass interrupted before a resume starts over: drop its commits and its summaries and reports.
  await withLock(async () => {
    if (fixBase && (await currentHead(opts.integrationWorktree)) !== fixBase) {
      opts.log(`fix pass ${pass}: discarding the commits of the interrupted pass`);
      await resetHard(opts.integrationWorktree, fixBase);
    }
  });
  await rm(path.dirname(fixerSummaryPath(opts.runDir, pass)), { recursive: true, force: true });
  const fixer = {
    round: pass,
    reports,
    specText: await readFile(opts.specPath, "utf8"),
    integrationWorktree: opts.integrationWorktree,
    provider: opts.provider,
    runDir: opts.runDir,
    checks: config.validate,
    withLock: opts.withLock,
    attempts: config.attempts,
    signal,
    hint,
    model: opts.model,
    log: opts.log,
  };
  // One fixer node for the whole pass: each fixer run restarts it under its own label, the gate shows as validating.
  let label = fixerLabel(pass);
  const rounds = config.validationRounds;
  const fix = (extra: Partial<FixerOptions> = {}): Promise<FixerResult> => {
    label = fixerLabel(pass, extra.validationRound);
    const round = extra.validationRound;
    const runLabel = label;
    // A validation fix round shows as `fixing N/M` on the fixer node, its retries as usual.
    const onAttempt =
      round === undefined
        ? attemptEvents(opts, "fixer", runLabel)
        : (attempt: number, previous?: AttemptFailure): void => {
            if (!previous) opts.events?.emit("agent:status", { agent: "fixer", status: "fixing", round, rounds, label: runLabel });
            else attemptEvents(opts, "fixer", runLabel)(attempt, previous);
          };
    return runFixer({ ...fixer, ...extra, onAttempt });
  };
  let ok = false;
  try {
    await fix();
    if (config.validate.length > 0) {
      const step = `fix pass ${pass} validation`;
      for (let round = 1; ; round++) {
        opts.events?.emit("agent:status", {
          agent: "fixer",
          status: "validating",
          ...(round > 1 ? { round: round - 1, rounds } : {}),
        });
        opts.log(
          round === 1
            ? `validating ${opts.integrationBranch} after fix pass ${pass}`
            : `validating ${opts.integrationBranch} again after fixer round ${round - 1}/${rounds}`,
        );
        const result = await runCommands(config.validate, opts.integrationWorktree, signal, {
          parallel: config.validateParallel,
        });
        if (signal.aborted) throw new InterruptedError(`${step} was interrupted`, { step, hint });
        if (result.ok) break;
        const failure = `\`${result.command}\` failed with exit code ${result.exitCode}`;
        const where = await writeValidationLog(path.join(opts.runDir, "logs"), `fix-pass${pass}-validate-${round}`, result);
        opts.log(`fix pass ${pass}: validation failed: ${where}`);
        if (round > rounds) {
          throw new AbortRunError(`validation failed after ${rounds} rounds: ${failure}`, { step, hint });
        }
        opts.log(`fix pass ${pass}: sent back to the fixer (round ${round}/${rounds})`);
        await onValidationRound(round);
        await fix({ validationFailure: result, validationRound: round });
      }
    }
    ok = true;
  } finally {
    opts.events?.emit("agent:end", { agent: "fixer", label, ok });
  }
}

const revParse = async (cwd: string, ref: string): Promise<string> =>
  (await execa("git", ["rev-parse", ref], { cwd })).stdout.trim();

/** The validation gate before the first review (PRD §7.4). There is nothing for a fixer to fix yet: a failure aborts. */
async function gate(opts: ReviewPhaseOptions, round: number): Promise<void> {
  const commands = opts.config.validate;
  if (commands.length === 0) return;
  const step = `review round ${round} validation`;
  opts.log(`validating ${opts.integrationBranch} before the review`);
  const result = await runCommands(commands, opts.integrationWorktree, opts.signal, {
    parallel: opts.config.validateParallel,
  });
  if (opts.signal.aborted) throw new InterruptedError(`${step} was interrupted`, { step, hint: opts.hint });
  if (!result.ok) {
    opts.log(`validation failed: ${await writeValidationLog(path.join(opts.runDir, "logs"), `review-validate`, result)}`);
    throw new AbortRunError(
      `validation of ${opts.integrationBranch} failed before the review: \`${result.command}\` exited with code ${result.exitCode}`,
      { step, hint: opts.hint },
    );
  }
}
