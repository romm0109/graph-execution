import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { loadTestPlan, type TestPlan } from "../graph/testPlan.js";

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
  const [spec, reviewMd, testingMd, testPlan, diff, names] = await Promise.all([
    readFile(opts.specPath, "utf8"),
    readOptional(path.join(opts.repoRoot, REVIEW_FILE)),
    readOptional(path.join(opts.repoRoot, TESTING_FILE)),
    loadTestPlan(opts.tasksDir),
    git(["diff", range]),
    git(["diff", "--name-only", range]),
  ]);
  return {
    spec,
    tasksDir: path.resolve(opts.tasksDir),
    diff,
    changedFiles: names.split("\n").filter(Boolean),
    ...(reviewMd !== undefined ? { reviewMd } : {}),
    ...(testingMd !== undefined ? { testingMd } : {}),
    ...(testPlan !== undefined ? { testPlan } : {}),
    ...(opts.fixerSummary !== undefined ? { fixerSummary: opts.fixerSummary } : {}),
  };
}
