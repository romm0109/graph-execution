import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { currentHead, hasNewCommit, resetHard } from "../git/git.js";
import type { MergeLock } from "../git/mutex.js";
import type { Provider } from "../providers/types.js";
import { type Finding, openBlocking, type Report } from "../review/report.js";
import { COMMIT_INSTRUCTION } from "./task.js";
import { fence } from "./reviewer.js";
import { type AttemptFailure, type CheckResult, withRetries } from "./retry.js";

/** A failing validation command after a fixer commit, fed back to the fixer (PRD §7.4). */
export interface ValidationFailure {
  command: string;
  output: string;
}

export interface FixerOptions {
  /** The fix pass, 1-based; it is also the round of the re-review that follows. */
  round: number;
  /** The previous review round's reports: the code reviewer's and the live tester's. */
  reports: readonly Report[];
  /** Full text of the `--spec` file. */
  specText: string;
  integrationWorktree: string;
  provider: Provider;
  /** `.graph-execution/<run-id>`; the commit summary goes to `reports/round<round>/`. */
  runDir: string;
  /** The config's validation commands, named in the prompt as the project's checks. */
  checks?: readonly string[];
  /** Set for a validation fix round after the pass's fixer commit failed the gate. */
  validationFailure?: ValidationFailure;
  /** 1-based validation fix round; only with `validationFailure`. */
  validationRound?: number;
  /** The run's integration-worktree lock; held for the whole fixer run, retries included. */
  withLock?: MergeLock;
  attempts?: number;
  signal: AbortSignal;
  hint: string;
  model?: string;
  /** Called before attempt `attempt` starts, with the previous attempt's failure on a retry. */
  onAttempt?: (attempt: number, previous?: AttemptFailure) => void;
  log?: (line: string) => void;
}

export interface FixerResult {
  commit: string;
  /** `git log -1 --format=%B` of the fixer's commit, passed to the next round's reviewers. */
  summary: string;
}

export const fixerLabel = (round: number, validationRound?: number): string =>
  validationRound === undefined ? `fix-r${round}` : `fix-r${round}-v${validationRound}`;

export const fixerSummaryPath = (runDir: string, round: number, validationRound?: number): string =>
  path.join(runDir, "reports", `round${round}`, `${fixerLabel(round, validationRound)}-summary.txt`);

const NAME = { code: "Code review", tester: "Live test" } as const;

const renderFinding = (f: Finding, reviewer: string): string => {
  const where = f.file ? ` \`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\`` : "";
  const out = [`- **${f.id}** (${f.severity}, ${reviewer})${where}: ${f.description}`];
  if (f.failureScenario) out.push(`  - Failure scenario: ${f.failureScenario}`);
  if (f.suggestedFix) out.push(`  - Suggested fix: ${f.suggestedFix}`);
  return out.join("\n");
};

/**
 * The fixer's prompt (PRD §7.6): the spec, then the open blocker and major findings of both reports, then the
 * minors as lower priority, then the full reports. A validation fix round adds the failing command's output.
 */
export function fixerPrompt(
  specText: string,
  reports: readonly Report[],
  checks: readonly string[] = [],
  validationFailure?: ValidationFailure,
): string {
  const blocking = reports.flatMap((r) => openBlocking(r).map((f) => renderFinding(f, NAME[r.reviewer])));
  const minors = reports.flatMap((r) =>
    r.findings.filter((f) => f.severity === "minor" && f.status !== "fixed").map((f) => renderFinding(f, NAME[r.reviewer])),
  );
  const out = [
    "You are the fixer of a change set built by AI coding agents from the specification below. Reviewers found the",
    "problems listed further down. Fix them in the current directory, which is the integration branch.",
    "",
    "## Specification",
    "",
    specText.trimEnd(),
    "",
    "## Blocker and major findings (fix all of them)",
    "",
    ...(blocking.length === 0 ? ["(none)"] : blocking),
    "",
    "## Minor findings (lower priority)",
    "",
    ...(minors.length === 0 ? ["(none)"] : minors),
    "",
    "## Full reports",
    "",
    ...reports.flatMap((r) => [`### ${NAME[r.reviewer]}`, "", fence(JSON.stringify(r, null, 2)), ""]),
    "## Instructions",
    "",
    "- Fix every blocker and major finding. You cannot decline a finding.",
    "- Keep each fix consistent with the specification: when a suggested fix contradicts it, fix the problem in a",
    "  way the specification allows instead.",
    "- Fix the minor findings too when it is cheap and safe; they never block the run.",
    checks.length > 0
      ? `- Run the project's checks before you commit: ${checks.map((c) => `\`${c}\``).join(", ")}.`
      : "- Run the project's checks (tests, type checks, linters) before you commit.",
    "- Write a commit message that lists, per finding id, what you changed; the reviewers read it next round.",
    "",
  ];
  if (validationFailure) {
    out.push(
      "## Validation failure",
      "",
      "Your committed fix fails a validation command.",
      `Failing command(s): ${validationFailure.command}`,
      "Output (tail):",
      fence(validationFailure.output),
      "Fix the code so this command succeeds, without weakening or skipping the check.",
      "",
    );
  }
  out.push(COMMIT_INSTRUCTION, "");
  return out.join("\n");
}

/**
 * Runs the fixer agent (PRD §7.6) in the integration worktree itself, under the integration lock, with retries: a
 * crash or a run without a new commit is retried from the head the fixer started at. The commit summary is
 * persisted next to the following round's reports. Only call it once both reviewers of the round have finished.
 */
export async function runFixer(opts: FixerOptions): Promise<FixerResult> {
  const { round, integrationWorktree: cwd, signal, hint } = opts;
  const log = opts.log ?? (() => undefined);
  const attempts = opts.attempts ?? 3;
  const label = fixerLabel(round, opts.validationRound);
  const step =
    opts.validationRound === undefined ? `fix pass ${round}` : `fix pass ${round} validation round ${opts.validationRound}`;
  const prompt = fixerPrompt(opts.specText, opts.reports, opts.checks, opts.validationFailure);
  const withLock = opts.withLock ?? (<T>(fn: () => Promise<T>) => fn());

  return withLock(async () => {
    const before = await currentHead(cwd);
    const check = async (exitCode: number): Promise<CheckResult<string>> => {
      if (exitCode !== 0) return { ok: false, reason: { class: "crash", message: `fixer exited with code ${exitCode}` } };
      if (!(await hasNewCommit(cwd, before))) {
        return { ok: false, reason: { class: "no_commit", message: "the fixer made no commit" } };
      }
      return { ok: true, value: await currentHead(cwd) };
    };

    const commit = await withRetries({
      attempts,
      label: step,
      hint,
      signal,
      onAttempt: (attempt, previous) => {
        if (previous) log(`${step}: ${previous.message}; retry ${attempt}/${attempts}`);
        else log(`${step}: running the fixer`);
        opts.onAttempt?.(attempt, previous);
      },
      // A retry drops whatever the failed attempt left behind, committed or not.
      prepare: async (attempt) => {
        if (attempt > 1) await resetHard(cwd, before);
      },
      execute: async () => {
        const agent = opts.provider.run({ role: "fixer", prompt, cwd, signal, model: opts.model, label });
        for await (const event of agent.events) {
          if (event.type === "output") log(`[fixer ${label}] ${event.text.trimEnd()}`);
        }
        return (await agent.done).exitCode;
      },
      check,
    });

    const summary = (await execa("git", ["log", "-1", "--format=%B", commit], { cwd })).stdout.trim();
    const file = fixerSummaryPath(opts.runDir, round, opts.validationRound);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${summary}\n`);
    return { commit, summary };
  });
}
