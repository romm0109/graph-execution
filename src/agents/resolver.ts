import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { currentHead, merge, resetHard } from "../git/git.js";
import type { Provider } from "../providers/types.js";
import { RetriesExhaustedError } from "../state/errors.js";
import { type CheckResult, withRetries } from "./retry.js";

export interface ResolveConflictsOptions {
  provider: Provider;
  /** The integration worktree, left mid-merge with conflicts by `merge`. */
  integrationWorktree: string;
  /** The task branch being merged. */
  branch: string;
  /** Conflicted files reported by `merge`, relative to the worktree. */
  files: string[];
  /** Merge commit message, used when the merge is re-run for a retry. */
  message: string;
  /** Identifies the resolver instance; the task id. */
  label: string;
  /** Names the step in errors, e.g. `task 2`. */
  step: string;
  hint: string;
  signal: AbortSignal;
  attempts?: number;
  model?: string;
  log?: (line: string) => void;
}

export function resolverPrompt(branch: string, files: string[]): string {
  return [
    `You are in the middle of a \`git merge\` of branch \`${branch}\` into the current branch, and it has conflicts.`,
    "Conflicted files:",
    ...files.map((f) => `- ${f}`),
    "",
    "Resolve every conflict in these files so that the result keeps the intent of both sides, and remove all",
    "conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). Then `git add` the resolved files and run",
    "`git commit --no-edit` to complete the merge commit. Do not abort the merge, rebase or reset.",
    "",
  ].join("\n");
}

const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;

const git = async (cwd: string, args: string[]): Promise<string> => (await execa("git", args, { cwd })).stdout.trim();

/**
 * Runs the merge resolver agent (PRD §7.3) in the integration worktree, up to `attempts` times. Each retry starts from
 * the same conflicted state: the failed attempt's work is dropped and the merge re-run. Exhaustion leaves the worktree
 * in that conflicted state and throws `RetriesExhaustedError`. Must run under the merge lock, as one critical section.
 * Returns the merge commit.
 */
export async function resolveConflicts(opts: ResolveConflictsOptions): Promise<string> {
  const { integrationWorktree: cwd, branch, files } = opts;
  const log = opts.log ?? (() => undefined);
  const attempts = opts.attempts ?? 3;
  // During a conflicted merge HEAD still points at the integration tip from before the merge.
  const before = await currentHead(cwd);
  const branchTip = await git(cwd, ["rev-parse", branch]);

  const restartMerge = async (): Promise<void> => {
    await execa("git", ["merge", "--abort"], { cwd, reject: false });
    // Also drops a merge commit a failed attempt may have created.
    await resetHard(cwd, before);
    const result = await merge(cwd, branch, opts.message);
    if (result.ok) throw new Error(`re-running the merge of ${branch} unexpectedly succeeded without conflicts`);
  };

  const check = async (exitCode: number): Promise<CheckResult<string>> => {
    if (exitCode !== 0) {
      return { ok: false, reason: { class: "crash", message: `resolver exited with code ${exitCode}` } };
    }
    const unmerged = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    if (unmerged.length > 0) {
      return { ok: false, reason: { class: "conflict_markers", message: `unmerged paths left: ${unmerged.join(", ")}` } };
    }
    const marked: string[] = [];
    for (const file of files) {
      const content = await readFile(path.join(cwd, file), "utf8").catch(() => "");
      if (CONFLICT_MARKER.test(content)) marked.push(file);
    }
    if (marked.length > 0) {
      return { ok: false, reason: { class: "conflict_markers", message: `conflict markers left in ${marked.join(", ")}` } };
    }
    const parents = (await git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ").slice(1);
    if (parents.length !== 2 || parents[0] !== before || parents[1] !== branchTip) {
      return {
        ok: false,
        reason: { class: "conflict_markers", message: `the merge commit of ${branch} was not created` },
      };
    }
    return { ok: true, value: await currentHead(cwd) };
  };

  try {
    return await withRetries({
      attempts,
      label: `${opts.step} merge resolver`,
      hint: opts.hint,
      signal: opts.signal,
      onAttempt: (attempt, previous) => {
        if (previous) log(`${opts.step}: resolver ${previous.message}; retry ${attempt}/${attempts}`);
        else log(`${opts.step}: merge conflict in ${files.join(", ")}; running the resolver`);
      },
      // The first attempt starts from the conflicted merge `merge` left behind.
      prepare: async (attempt) => {
        if (attempt > 1) await restartMerge();
      },
      execute: async () => {
        const agent = opts.provider.run({
          role: "resolver",
          prompt: resolverPrompt(branch, files),
          cwd,
          signal: opts.signal,
          model: opts.model,
          label: opts.label,
        });
        for await (const event of agent.events) {
          if (event.type === "output") log(`[resolver ${opts.label}] ${event.text.trimEnd()}`);
        }
        return (await agent.done).exitCode;
      },
      check,
    });
  } catch (err) {
    // Keep the conflicted merge for inspection instead of a half-resolved one (or a merge commit with markers).
    if (err instanceof RetriesExhaustedError) await restartMerge();
    throw err;
  }
}
