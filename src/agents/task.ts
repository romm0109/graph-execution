import type { Task } from "../graph/task.js";

export const COMMIT_INSTRUCTION =
  "When you are done, commit all of your changes to the current branch with git. Work that is not committed is lost.";

/** The task agent sees only its own content plus the commit instruction (PRD §7.2): no spec, no dependency text. */
export function taskPrompt(task: Task): string {
  return `${task.content}\n\n${COMMIT_INSTRUCTION}\n`;
}

/** Sent to the task agent, in the same worktree, when a validation command fails after its commit (PRD §7.4). */
export function validationFixPrompt(task: Task, failure: { command: string; output: string }): string {
  return [
    task.content,
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
