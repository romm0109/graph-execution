import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { withLiveChecks } from "./human.js";
import { loadTestPlan, type TestCase, type TestPlan } from "../graph/testPlan.js";

export const REVIEW_FILE = "REVIEW.md";
export const TESTING_FILE = "TESTING.md";

export interface ReviewerContextOptions {
  specPath: string;
  tasksDir: string;
  /** The user's repo root, where the optional `REVIEW.md` and `TESTING.md` are read from (they may be uncommitted). */
  repoRoot: string;
  /** The starting commit recorded at startup, the base of the diff. */
  startingCommit: string;
  integrationWorktree: string;
  /** The fixer's commit summary of the previous fix pass; from the second review round on. */
  fixerSummary?: string;
  /** Extra `must` cases for the live tester (human "needs live check" comments), added to the run's plan. */
  extraCases?: TestCase[];
  /** Limits the reviewer `diff` to these files (the suite's e2e phase: files changed by more than one feature). */
  reviewFiles?: readonly string[];
  /** Repo-root files to read (each reviewer's `repoFile`); default `[REVIEW_FILE, TESTING_FILE]`. */
  repoFiles?: readonly string[];
}

export interface ReviewerContext {
  /** Full text of the `--spec` file. */
  spec: string;
  /** Absolute path of the tasks folder; the reviewer may read the task files itself. */
  tasksDir: string;
  /** `git diff <startingCommit>..HEAD` of the integration branch; the code reviewer's only. */
  diff: string;
  /** `git diff --name-only <startingCommit>..HEAD`; the live tester's hint for what to exercise. */
  changedFiles: string[];
  /** `REVIEW.md` from the repo root, when present; the code reviewer's only. */
  reviewMd?: string;
  /** `TESTING.md` from the repo root, when present; the live tester's only. */
  testingMd?: string;
  /** Text of each requested repo-root file that exists, by file name; each reviewer gets only its own `repoFile`. */
  repoFiles?: Record<string, string>;
  /** The fixer's commit summary of the previous fix pass; both reviewers get it from the second round on. */
  fixerSummary?: string;
  /** The user's `test-plan.json` from the tasks folder, when present; the live tester's only. */
  testPlan?: TestPlan;
}

/** Reads a file that may be absent; only absence is tolerated, other read errors still throw. */
async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Gathers the reviewers' context (PRD §7.5). Files are read by the tool from the user's repo root, not from the
 * throwaway worktrees, so an uncommitted `REVIEW.md` or `TESTING.md` still counts. A missing one is never an error.
 */
export async function buildReviewerContext(opts: ReviewerContextOptions): Promise<ReviewerContext> {
  const git = (args: string[]): Promise<string> =>
    execa("git", args, { cwd: opts.integrationWorktree }).then((r) => r.stdout);
  const range = `${opts.startingCommit}..HEAD`;
  const repoNames = [...new Set(opts.repoFiles ?? [REVIEW_FILE, TESTING_FILE])];
  const [spec, texts, loadedPlan, diff, names] = await Promise.all([
    readFile(opts.specPath, "utf8"),
    Promise.all(repoNames.map((name) => readOptional(path.join(opts.repoRoot, name)))),
    loadTestPlan(opts.tasksDir),
    opts.reviewFiles === undefined
      ? git(["diff", range])
      : opts.reviewFiles.length === 0
        ? Promise.resolve("")
        : git(["diff", range, "--", ...opts.reviewFiles]),
    git(["diff", "--name-only", range]),
  ]);
  const repoFiles: Record<string, string> = {};
  repoNames.forEach((name, i) => {
    const text = texts[i];
    if (text !== undefined) repoFiles[name] = text;
  });
  const reviewMd = repoFiles[REVIEW_FILE];
  const testingMd = repoFiles[TESTING_FILE];
  const testPlan = withLiveChecks(loadedPlan, opts.extraCases ?? []);
  return {
    spec,
    tasksDir: path.resolve(opts.tasksDir),
    diff,
    changedFiles: names.split("\n").filter(Boolean),
    repoFiles,
    ...(reviewMd !== undefined ? { reviewMd } : {}),
    ...(testingMd !== undefined ? { testingMd } : {}),
    ...(testPlan !== undefined ? { testPlan } : {}),
    ...(opts.fixerSummary !== undefined ? { fixerSummary: opts.fixerSummary } : {}),
  };
}

/** The text of the repo-root `file` in `ctx`, when present; falls back to `reviewMd`/`testingMd` of hand-built contexts. */
export function repoText(ctx: Pick<ReviewerContext, "repoFiles" | "reviewMd" | "testingMd">, file: string): string | undefined {
  return ctx.repoFiles?.[file] ?? (file === REVIEW_FILE ? ctx.reviewMd : file === TESTING_FILE ? ctx.testingMd : undefined);
}

/** `git diff <startingCommit>..HEAD -- <files>` in the integration worktree; `""` for no files. */
export async function diffOf(integrationWorktree: string, startingCommit: string, files: readonly string[]): Promise<string> {
  if (files.length === 0) return "";
  const r = await execa("git", ["diff", `${startingCommit}..HEAD`, "--", ...files], { cwd: integrationWorktree });
  return r.stdout;
}
