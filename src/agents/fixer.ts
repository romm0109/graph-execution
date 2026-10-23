import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { commitLeftovers, currentHead, dirtyPaths, hasNewCommit, resetHard } from "../git/git.js";
import type { MergeLock } from "../git/mutex.js";
import type { Provider } from "../providers/types.js";
import { type Finding, openBlocking, type Report } from "../review/report.js";
import { type Comment, commentFindingId, commentWhere, fixerCommentsPath, parseSuggestion, REMOVED_NOTE } from "../review/human.js";
import { COMMIT_INSTRUCTION, PROCESS_INSTRUCTION } from "./task.js";
import { fence } from "./reviewer.js";
import { type AttemptFailure, type CheckResult, withRetries } from "./retry.js";

/** A failing validation command after a fixer commit, fed back to the fixer (PRD §7.4). */
export interface ValidationFailure {
  command: string;
  output: string;
}

export interface FixerOptions {
  /** The fix pass, 1-based; it is also the round of the re-review that follows. 0 for the gate before the first review. */
  round: number;
  /** The previous review round's reports: the code reviewer's and the live tester's; none before the first review. */
  reports: readonly Report[];
  /** Full text of the `--spec` file. */
  specText: string;
  integrationWorktree: string;
  /** Several repos: `integrationWorktree` is then the workspace holding them, the agent's cwd; commits, leftovers and retries are per repo. */
  repos?: readonly { name: string; worktree: string }[];
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
  /** The open human review comments, listed before the findings. */
  comments?: readonly Comment[];
  /** Called before attempt `attempt` starts, with the previous attempt's failure on a retry. */
  onAttempt?: (attempt: number, previous?: AttemptFailure) => void;
  /** The fixer agent starts in `cwd`; `base` is the head it started from, `exclude` what was already dirty. */
  onAgentStart?: (cwd: string, base: string, exclude: string[]) => void;
  /** The fixer agent stopped, whatever the outcome; `commit` is the head it ended on when the attempt succeeded. */
  onAgentEnd?: (commit?: string) => void;
  log?: (line: string) => void;
}

export interface FixerResult {
  /** The new head; with several repos, the first changed repo's. */
  commit: string;
  /** Several repos: the new head of every repo that changed, by name. */
  commits?: Record<string, string>;
  /** `git log -1 --format=%B` of the fixer's commit, passed to the next round's reviewers. */
  summary: string;
}

export const fixerLabel = (round: number, validationRound?: number): string =>
  validationRound === undefined ? `fix-r${round}` : `fix-r${round}-v${validationRound}`;

export const fixerSummaryPath = (runDir: string, round: number, validationRound?: number): string =>
  path.join(runDir, "reports", `round${round}`, `${fixerLabel(round, validationRound)}-summary.txt`);

const NAME = { code: "Code review", tester: "Live test" } as const;

const renderFinding = (f: Finding, reviewer: string): string => {
  const where = f.file ? ` \`${f.file}${f.line !== undefined ? `:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}` : ""}\`` : "";
  const out = [`- **${f.id}** (${f.severity}, ${reviewer})${where}: ${f.description}`];
  if (f.failureScenario) out.push(`  - Failure scenario: ${f.failureScenario}`);
  if (f.suggestedFix) out.push(`  - Suggested fix: ${f.suggestedFix}`);
  return out.join("\n");
};

const humanSection = (comments: readonly Comment[]): string[] =>
  comments.length === 0
    ? []
    : [
        "## Human review comments (fix all of them)",
        "",
        "The user reviewed the result and asked for these changes. They come first.",
        "",
        ...comments.flatMap((c) => {
          const out = [`- **${commentFindingId(c.id)}**${commentWhere(c)}: ${[c.body, ...c.followUps].join("\n  Follow-up: ")}`];
          if (c.side === "old" && c.startLine) out.push(`  ${REMOVED_NOTE}`);
          if (c.snippet) out.push(`  Code: ${fence(c.snippet)}`);
          const suggestion = parseSuggestion(c.body);
          if (suggestion !== undefined) {
            out.push("  Suggested replacement for these lines (apply it exactly unless that breaks the build; if you deviate, say why in your note):", fence(suggestion));
          }
          return out;
        }),
        "",
      ];

const repoLine = (names: readonly string[]): string[] =>
  names.length > 0 ? [`- Your folder holds several git repos: ${names.join(", ")}. Each is a separate repo; commit in the repo you changed.`] : [];

/**
 * The fixer's prompt (PRD §7.6): the spec, then the open blocker and major findings of both reports, then the
 * minors as lower priority, then the full reports. A validation fix round adds the failing command's output.
 */
export function fixerPrompt(
  specText: string,
  reports: readonly Report[],
  checks: readonly string[] = [],
  validationFailure?: ValidationFailure,
  comments: readonly Comment[] = [],
  notesPath?: string,
  repoNames: readonly string[] = [],
): string {
  if (reports.length === 0 && validationFailure) return gateFixerPrompt(specText, validationFailure, repoNames);
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
    ...humanSection(comments),
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
    ...repoLine(repoNames),
    "- Fix every blocker and major finding. You cannot decline a finding.",
    "- Keep each fix consistent with the specification: when a suggested fix contradicts it, fix the problem in a",
    "  way the specification allows instead.",
    "- Fix the minor findings too when it is cheap and safe; they never block the run.",
    checks.length > 0
      ? `- Run the project's checks before you commit: ${checks.map((c) => `\`${c}\``).join(", ")}.`
      : "- Run the project's checks (tests, type checks, linters) before you commit.",
    "- Write a commit message that lists, per finding id, what you changed; the reviewers read it next round.",
    ...(comments.length > 0
      ? [`- List, per comment id (${comments.map((c) => commentFindingId(c.id)).join(", ")}), what you changed in the commit message.`]
      : []),
    ...(comments.some((c) => parseSuggestion(c.body) !== undefined)
      ? ["- A suggested replacement replaces exactly the commented lines (new side), nothing more."]
      : []),
    ...(comments.length > 0 && notesPath
      ? [
          `- After committing, write a JSON array to \`${notesPath}\` with one { "id": "H1-1", "note": "<one or two sentences on what you changed>" } per comment.`,
        ]
      : []),
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
  out.push(COMMIT_INSTRUCTION, PROCESS_INSTRUCTION, "");
  return out.join("\n");
}

/**
 * The fixer's prompt for the validation gate before the first review: there are no findings yet, only the merged
 * tasks failing a validation command.
 */
function gateFixerPrompt(specText: string, validationFailure: ValidationFailure, repoNames: readonly string[]): string {
  return [
    "You are the fixer of a change set built by AI coding agents from the specification below. Every task is merged",
    "into the current directory, which is the integration branch, and the result fails a validation command.",
    "",
    "## Specification",
    "",
    specText.trimEnd(),
    "",
    "## Validation failure",
    "",
    `Failing command(s): ${validationFailure.command}`,
    "Output (tail):",
    fence(validationFailure.output),
    "",
    "## Instructions",
    "",
    ...repoLine(repoNames),
    "- Fix the code so this command succeeds, without weakening or skipping the check.",
    "- Keep each fix consistent with the specification.",
    "- Write a commit message that says what you changed and why; the reviewers read it.",
    "",
    COMMIT_INSTRUCTION,
    PROCESS_INSTRUCTION,
    "",
  ].join("\n");
}

/** The fixer's step name in logs and errors: `validation fix round V` before the first review. */
const fixerStep = (round: number, validationRound?: number): string =>
  validationRound === undefined
    ? `fix pass ${round}`
    : round === 0
      ? `validation fix round ${validationRound}`
      : `fix pass ${round} validation round ${validationRound}`;

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
  const multi = (opts.repos?.length ?? 0) > 1;
  const step = fixerStep(round, opts.validationRound);
  const prompt = fixerPrompt(
    opts.specText,
    opts.reports,
    opts.checks,
    opts.validationFailure,
    opts.comments,
    fixerCommentsPath(path.resolve(opts.runDir), round),
    multi ? opts.repos!.map((r) => r.name) : [],
  );
  const withLock = opts.withLock ?? (<T>(fn: () => Promise<T>) => fn());

  if (multi) return withLock(() => runMultiRepoFixer(opts, prompt, label, step, attempts, log));

  return withLock(async () => {
    const before = await currentHead(cwd);
    /** What was already dirty when the attempt's fixer started (validation output), kept out of its leftovers. */
    let dirtyAtStart: string[] = [];
    const check = async (exitCode: number): Promise<CheckResult<string>> => {
      const result = await checkAttempt(exitCode);
      opts.onAgentEnd?.(result.ok ? result.value : undefined);
      return result;
    };
    const checkAttempt = async (exitCode: number): Promise<CheckResult<string>> => {
      if (exitCode !== 0) return { ok: false, reason: { class: "crash", message: `fixer exited with code ${exitCode}` } };
      if (await commitLeftovers(cwd, `Fixer (${step}): changes the agent left uncommitted`, dirtyAtStart)) {
        log(`${step}: committed changes the fixer left uncommitted`);
      }
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
        dirtyAtStart = await dirtyPaths(cwd);
        opts.onAgentStart?.(cwd, before, dirtyAtStart);
        try {
          const agent = opts.provider.run({ role: "fixer", prompt, cwd, signal, model: opts.model, label });
          for await (const event of agent.events) {
            if (event.type === "output") log(`[fixer ${label}] ${event.text.trimEnd()}`);
          }
          return (await agent.done).exitCode;
        } catch (err) {
          // `check` reports the end of an agent that returned.
          opts.onAgentEnd?.();
          throw err;
        }
      },
      check,
    });

    // Every commit of the attempt, newest first: a leftover commit by the tool must not hide the fixer's own message.
    const summary = (await execa("git", ["log", "--format=%B", `${before}..${commit}`], { cwd })).stdout.trim();
    const file = fixerSummaryPath(opts.runDir, round, opts.validationRound);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${summary}\n`);
    return { commit, summary };
  });
}

/** `runFixer` over several repos: the agent runs in the workspace, commits and retries are per repo. */
async function runMultiRepoFixer(
  opts: FixerOptions,
  prompt: string,
  label: string,
  step: string,
  attempts: number,
  log: (line: string) => void,
): Promise<FixerResult> {
  const { round, integrationWorktree: cwd, signal, hint } = opts;
  const repos = opts.repos!;
  const before = new Map<string, string>();
  for (const r of repos) before.set(r.name, await currentHead(r.worktree));
  const dirtyAtStart = new Map<string, string[]>();
  const heads = new Map<string, string>();

  await withRetries({
    attempts,
    label: step,
    hint,
    signal,
    onAttempt: (attempt, previous) => {
      if (previous) log(`${step}: ${previous.message}; retry ${attempt}/${attempts}`);
      else log(`${step}: running the fixer`);
      opts.onAttempt?.(attempt, previous);
    },
    // A retry drops whatever the failed attempt left behind, in every repo.
    prepare: async (attempt) => {
      if (attempt > 1) for (const r of repos) await resetHard(r.worktree, before.get(r.name)!);
    },
    execute: async () => {
      for (const r of repos) dirtyAtStart.set(r.name, await dirtyPaths(r.worktree));
      const agent = opts.provider.run({ role: "fixer", prompt, cwd, signal, model: opts.model, label });
      for await (const event of agent.events) {
        if (event.type === "output") log(`[fixer ${label}] ${event.text.trimEnd()}`);
      }
      return (await agent.done).exitCode;
    },
    check: async (exitCode): Promise<CheckResult<string>> => {
      if (exitCode !== 0) return { ok: false, reason: { class: "crash", message: `fixer exited with code ${exitCode}` } };
      heads.clear();
      for (const r of repos) {
        const message = `Fixer (${step}): changes the agent left uncommitted`;
        if (await commitLeftovers(r.worktree, message, dirtyAtStart.get(r.name) ?? [])) {
          log(`${step}: committed changes the fixer left uncommitted in ${r.name}`);
        }
        if (await hasNewCommit(r.worktree, before.get(r.name)!)) heads.set(r.name, await currentHead(r.worktree));
      }
      if (heads.size === 0) {
        return { ok: false, reason: { class: "no_commit", message: "the fixer made no commit in any repo" } };
      }
      return { ok: true, value: "" };
    },
  });

  const commits = Object.fromEntries(heads);
  const summary = (
    await Promise.all(
      repos
        .filter((r) => heads.has(r.name))
        .map(async (r) => {
          const log = (await execa("git", ["log", "--format=%B", `${before.get(r.name)}..${heads.get(r.name)}`], { cwd: r.worktree })).stdout.trim();
          return `## ${r.name}\n${log}`;
        }),
    )
  ).join("\n\n");
  const file = fixerSummaryPath(opts.runDir, round, opts.validationRound);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${summary}\n`);
  return { commit: Object.values(commits)[0]!, commits, summary };
}
