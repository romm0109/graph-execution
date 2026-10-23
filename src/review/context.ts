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
  /** Several repos: the diff, changed files, REVIEW.md and TESTING.md cover each, prefixed by its name. `reviewFiles` entries are then `<name>/<path>`. */
  repos?: readonly { name: string; repoRoot: string; startingCommit: string; integrationWorktree: string }[];
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
  if (opts.repos && opts.repos.length > 1) return buildMultiRepoContext(opts, opts.repos);
  const git = (args: string[]): Promise<string> =>
    execa("git", args, { cwd: opts.integrationWorktree }).then((r) => r.stdout);
  const range = `${opts.startingCommit}..HEAD`;
  const [spec, reviewMd, testingMd, loadedPlan, diff, names] = await Promise.all([
    readFile(opts.specPath, "utf8"),
    readOptional(path.join(opts.repoRoot, REVIEW_FILE)),
    readOptional(path.join(opts.repoRoot, TESTING_FILE)),
    loadTestPlan(opts.tasksDir),
    opts.reviewFiles === undefined
      ? git(["diff", range])
      : opts.reviewFiles.length === 0
        ? Promise.resolve("")
        : git(["diff", range, "--", ...opts.reviewFiles]),
    git(["diff", "--name-only", range]),
  ]);
  const testPlan = withLiveChecks(loadedPlan, opts.extraCases ?? []);
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

/** The several-repos variant of `buildReviewerContext`: each repo's part, prefixed with its name. */
async function buildMultiRepoContext(
  opts: ReviewerContextOptions,
  repos: NonNullable<ReviewerContextOptions["repos"]>,
): Promise<ReviewerContext> {
  const perRepo = await Promise.all(
    repos.map(async (r) => {
      const git = (args: string[]): Promise<string> => execa("git", args, { cwd: r.integrationWorktree }).then((o) => o.stdout);
      const range = `${r.startingCommit}..HEAD`;
      const files = opts.reviewFiles
        ?.filter((f) => f.slice(0, f.indexOf("/")) === r.name)
        .map((f) => f.slice(r.name.length + 1));
      const [reviewMd, testingMd, diff, names] = await Promise.all([
        readOptional(path.join(r.repoRoot, REVIEW_FILE)),
        readOptional(path.join(r.repoRoot, TESTING_FILE)),
        files !== undefined && files.length === 0
          ? Promise.resolve("")
          : git(["diff", `--src-prefix=a/${r.name}/`, `--dst-prefix=b/${r.name}/`, range, ...(files ? ["--", ...files] : [])]),
        git(["diff", "--name-only", range]),
      ]);
      return { name: r.name, reviewMd, testingMd, diff, names: names.split("\n").filter(Boolean).map((n) => `${r.name}/${n}`) };
    }),
  );
  const joined = (pick: (r: (typeof perRepo)[number]) => string | undefined): string | undefined => {
    const parts = perRepo.flatMap((r) => {
      const text = pick(r);
      return text === undefined ? [] : [`## ${r.name}\n\n${text}`];
    });
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };
  const reviewMd = joined((r) => r.reviewMd);
  const testingMd = joined((r) => r.testingMd);
  const [spec, loadedPlan] = await Promise.all([readFile(opts.specPath, "utf8"), loadTestPlan(opts.tasksDir)]);
  const testPlan = withLiveChecks(loadedPlan, opts.extraCases ?? []);
  return {
    spec,
    tasksDir: path.resolve(opts.tasksDir),
    diff: perRepo.map((r) => r.diff).join("\n"),
    changedFiles: perRepo.flatMap((r) => r.names),
    ...(reviewMd !== undefined ? { reviewMd } : {}),
    ...(testingMd !== undefined ? { testingMd } : {}),
    ...(testPlan !== undefined ? { testPlan } : {}),
    ...(opts.fixerSummary !== undefined ? { fixerSummary: opts.fixerSummary } : {}),
  };
}
