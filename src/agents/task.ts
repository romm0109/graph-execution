import type { Task } from "../graph/task.js";
import type { AttemptFailure } from "./retry.js";

export const COMMIT_INSTRUCTION =
  "When you are done, commit all of your changes to the current branch with git. Work that is not committed is lost.";

/** How a task finishes whose work is already in the checkout: an empty commit, which the tool counts like any other. */
export const alreadyDoneInstruction = (task: Task): string =>
  "If everything this task asks for is already present and working in the checkout (for example because an " +
  "earlier task delivered it), do not invent changes. Record it with an empty commit instead: " +
  `\`git commit --allow-empty -m "Task ${task.id}: already implemented"\`, with a body that says where the work is.`;

/** A file the run's agents may read that is not committed, so it is missing from their checkouts. */
export interface ReferenceFile {
  /** What it is, e.g. `Spec` or `Task files`. */
  what: string;
  /** Its path in the user's repo, as the task text may refer to it. */
  name: string;
  /** Where the run keeps a copy for the agents. */
  path: string;
}

/** The reference section of an agent's prompt; empty without references. */
export function referenceSection(refs: readonly ReferenceFile[]): string[] {
  if (refs.length === 0) return [];
  return [
    "## Reference files outside this checkout",
    "",
    "These may not be committed, so they may be missing from your checkout. Read them from the paths below when the",
    "task refers to them. Do not copy them into the repository.",
    "",
    ...refs.map((r) => `- ${r.what} (\`${r.name}\`): \`${r.path}\``),
    "",
  ];
}

export interface TaskPromptOptions {
  references?: readonly ReferenceFile[];
  /** Why the previous attempt failed, on a retry. */
  previous?: AttemptFailure;
}

/**
 * The task agent's prompt (PRD §7.2): the task's own content, where to find the spec and the task files, and the
 * commit instruction, including how to finish a task whose work already exists. No dependency text. A retry is told
 * why the previous attempt failed.
 */
export function taskPrompt(task: Task, opts: TaskPromptOptions = {}): string {
  const out = [task.content.trimEnd(), "", ...referenceSection(opts.references ?? [])];
  if (opts.previous) {
    out.push(
      "## Previous attempt",
      "",
      `A previous attempt at this task failed: ${opts.previous.message}. You are in a fresh checkout.`,
      ...(opts.previous.class === "no_commit"
        ? ["If that was because the work already exists, finish with the empty commit described below."]
        : []),
      "",
    );
  }
  out.push(COMMIT_INSTRUCTION, alreadyDoneInstruction(task), "");
  return out.join("\n");
}

/** Sent to the task agent, in the same worktree, when a validation command fails after its commit (PRD §7.4). */
export function validationFixPrompt(
  task: Task,
  failure: { command: string; output: string },
  references: readonly ReferenceFile[] = [],
): string {
  return [
    task.content,
    "",
    ...referenceSection(references),
    "---",
    "Your committed work for the task above fails a validation command.",
    `Command: ${failure.command}`,
    "Output (tail):",
    "```",
    failure.output.trimEnd(),
    "```",
    "Fix the code so this command succeeds, without weakening or skipping the check.",
    "",
    COMMIT_INSTRUCTION,
    "",
  ].join("\n");
}
