import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import {
  addDetachedWorktree,
  commitLeftovers,
  currentHead,
  dirtyPaths,
  hasNewCommit,
  removeWorktreeIfPresent,
  resetHard,
} from "../git/git.js";
import { type CommandsResult, runCommands } from "../validate/commands.js";
import { matchFiles } from "./reviewers.js";

/** The git side of the folder the fixer works in. Heads are a sha (one repo) or a joint head `api=<sha> web=<sha>`. */
export interface FixerVcs {
  head(): Promise<string>;
  /** Uncommitted paths, as `dirtyPaths` lists them; prefixed `<repo>/` for several repos. */
  dirty(): Promise<string[]>;
  /** Commits what was left uncommitted, except `preexisting` paths; true when it committed anything (in any repo). */
  commitLeftovers(message: string, preexisting: readonly string[]): Promise<boolean>;
  /** True when HEAD has a commit `since` does not have (in any repo). */
  hasNewCommit(since: string): Promise<boolean>;
  /** `resetHard` to `head` (every repo): drops commits and tracked/untracked changes made since. */
  resetTo(head: string): Promise<void>;
  /** `git log --format=%B from..to`, newest first; for several repos each changed repo's log under a `[<name>]` line. */
  messages(from: string, to: string): Promise<string>;
}

/** What the review phase works on: the integration worktree of a run or suite, or the joint worktrees of a multi-repo suite. */
export interface ReviewWorkspace extends FixerVcs {
  /** The fixer's cwd: the integration worktree, or `<suiteDir>/worktrees/joint`. */
  dir: string;
  /** How log lines and errors name the result: `graph/<rid>`, or `suite/<rid> in api, web`. */
  label: string;
  /** The base of the diff: the starting commit, or the joint head of every repo's starting commit. */
  base: string;
  /** `git diff <base>..HEAD`, limited to `files` when given (`""` for an empty list); paths as the reviewers see them. */
  diff(files?: readonly string[]): Promise<string>;
  /** `git diff --name-only <base>..HEAD`, in the same path form as `diff`. */
  changedFiles(): Promise<string[]>;
  /** The text of each repo-root file that exists, by file name. */
  repoFiles(names: readonly string[]): Promise<Record<string, string>>;
  /** The validation commands as the fixer's prompt names them; empty means no validation gate. */
  checks: readonly string[];
  /** Runs every validation command; the failure names the command (and the repo). */
  validate(signal: AbortSignal): Promise<CommandsResult>;
  /** A reviewer's throwaway checkout of `head` at `dir`, and its removal (also of a half-created one). */
  addCheckout(dir: string, head: string): Promise<void>;
  removeCheckout(dir: string): Promise<void>;
  /** The changed files a reviewer's `files` globs select. */
  matchFiles(files: readonly string[], globs: readonly string[]): string[];
  /** Extra text for every reviewer, tester and fixer prompt (where the repos are, the path prefixes). */
  note?: string;
  /** Set when the live tester cannot run without a test plan: its report becomes `<notPerformed>: <this>` without an agent. */
  noPlanReason?: string;
}

/** A joint head: `api=<sha> web=<sha>`, in insertion order. */
export const formatHeads = (heads: Readonly<Record<string, string>>): string =>
  Object.entries(heads)
    .map(([name, sha]) => `${name}=${sha}`)
    .join(" ");

const HEAD_TOKEN = /^([A-Za-z0-9_-]+)=([0-9a-f]{4,64})$/i;

/** The shas of a joint head by repo name; undefined for a plain sha or a malformed value. */
export function parseHeads(text: string): Record<string, string> | undefined {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const heads: Record<string, string> = {};
  for (const token of tokens) {
    const m = HEAD_TOKEN.exec(token);
    if (!m) return undefined;
    heads[m[1]!] = m[2]!;
  }
  return heads;
}

/** A head for log lines: the first 12 characters of a sha, or of each sha of a joint head. */
export const shortHead = (head: string): string => {
  const heads = parseHeads(head);
  if (!heads) return head.slice(0, 12);
  return formatHeads(Object.fromEntries(Object.entries(heads).map(([name, sha]) => [name, sha.slice(0, 12)])));
};

/** A repo's file as the joint reviewers see it: `api/src/x.ts`. */
export const prefixPath = (name: string, file: string): string => `${name}/${file.replaceAll("\\", "/")}`;

/** Splits `api/src/x.ts` into { name: "api", path: "src/x.ts" } when `api` is one of `names`. */
export function splitPrefixed(file: string, names: readonly string[]): { name: string; path: string } | undefined {
  const normal = file.replaceAll("\\", "/");
  const at = normal.indexOf("/");
  if (at <= 0) return undefined;
  const name = normal.slice(0, at);
  return names.includes(name) ? { name, path: normal.slice(at + 1) } : undefined;
}

/** Reads a file that may be absent; only absence is tolerated, other read errors still throw. */
export async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The FixerVcs of one git worktree: today's behaviour of `runFixer`. */
export function worktreeVcs(worktree: string): FixerVcs {
  return {
    head: () => currentHead(worktree),
    dirty: () => dirtyPaths(worktree),
    commitLeftovers: (message, preexisting) => commitLeftovers(worktree, message, preexisting),
    hasNewCommit: (since) => hasNewCommit(worktree, since),
    resetTo: (head) => resetHard(worktree, head),
    messages: async (from, to) => (await execa("git", ["log", "--format=%B", `${from}..${to}`], { cwd: worktree })).stdout.trim(),
  };
}

export interface SingleWorkspaceOptions {
  repo: string;
  worktree: string;
  branch: string;
  startingCommit: string;
  /** Where repo-root files (REVIEW.md, TESTING.md, a reviewer's repoFile) are read from. */
  repoRoot: string;
  validate: readonly string[];
  validateParallel: boolean;
}

/** The workspace of a run or a single-repo suite: one integration worktree on one branch of one repo. */
export function singleWorkspace(o: SingleWorkspaceOptions): ReviewWorkspace {
  const git = (args: string[]): Promise<string> => execa("git", args, { cwd: o.worktree }).then((r) => r.stdout);
  const range = `${o.startingCommit}..HEAD`;
  return {
    ...worktreeVcs(o.worktree),
    dir: o.worktree,
    label: o.branch,
    base: o.startingCommit,
    head: async () => (await execa("git", ["rev-parse", o.branch], { cwd: o.repo })).stdout.trim(),
    diff: (files) =>
      files === undefined ? git(["diff", range]) : files.length === 0 ? Promise.resolve("") : git(["diff", range, "--", ...files]),
    changedFiles: async () => (await git(["diff", "--name-only", range])).split("\n").filter(Boolean),
    repoFiles: async (names) => {
      const texts = await Promise.all(names.map((name) => readOptional(path.join(o.repoRoot, name))));
      const out: Record<string, string> = {};
      names.forEach((name, i) => {
        const text = texts[i];
        if (text !== undefined) out[name] = text;
      });
      return out;
    },
    checks: o.validate,
    validate: (signal) => runCommands(o.validate, o.worktree, signal, { parallel: o.validateParallel }),
    addCheckout: (dir, head) => addDetachedWorktree(o.repo, dir, head),
    removeCheckout: (dir) => removeWorktreeIfPresent(o.repo, dir),
    matchFiles: (files, globs) => matchFiles(files, globs),
  };
}
