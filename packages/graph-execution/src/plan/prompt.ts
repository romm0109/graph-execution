import { readFile } from "node:fs/promises";
import path from "node:path";
import { fence } from "../agents/reviewer.js";
import { SKILLS_SOURCE } from "../install/skills.js";
import type { PlanRef } from "../state/state.js";

/** The fake provider finds the result path in the planner's prompt with this pattern. */
export const PLAN_RESULT_PATH_PATTERN = /Write the JSON result to this absolute path: `([^`]+)`/;
/** The content file's path in the planner's prompt. */
export const PLAN_CONTENT_PATH_PATTERN = /The content is in this file: `([^`]+)`/;

/** The refs file's path in the planner's prompt (only with refs). */
export const PLAN_REFS_PATH_PATTERN = /The refs are in this file: `([^`]+)`/;

/** The prompt line naming the result file. */
export const planResultPathLine = (p: string): string => `Write the JSON result to this absolute path: \`${p}\``;
/** The prompt line naming the content file. */
export const planContentPathLine = (p: string): string => `The content is in this file: \`${p}\``;
/** The prompt line naming the refs file. */
export const planRefsPathLine = (p: string): string => `The refs are in this file: \`${p}\``;

/** The bundled `validate-tasks.mjs`, as an absolute path for the planner. */
export const validateTasksScript = (): string => path.join(SKILLS_SOURCE, "to-tasks", "validate-tasks.mjs");

export interface PlannerPromptInput {
  /** The free markdown the plan is made from. */
  content: string;
  /** The run's copy of the content. */
  contentPath: string;
  /** Where the planner writes its result. */
  resultPath: string;
  /** Plan names in use already. */
  taken: string[];
  /** Absolute path of `validate-tasks.mjs`. */
  validateScript: string;
  /** The items the content describes; empty: the content is one unit. */
  refs?: PlanRef[];
  /** The run's copy of the refs (set when there are refs). */
  refsPath?: string;
  /** Why the engine rejected the previous round, when this is a retry. */
  previousError?: string;
  /** Feedback texts of rejected plans, oldest first. */
  feedback: string[];
  /** The last rejected plan's commit (`Plan: <name>`), when there was one. */
  rejectedCommit?: string;
}

/** One line per ref: `- KAN-41: <title> (<url>)`. */
const refLine = (r: PlanRef): string => `- ${r.ref}${r.title ? `: ${r.title}` : ""}${r.url ? ` (${r.url})` : ""}`;

/** The planner's prompt: a headless preamble, the bundled to-spec and to-tasks skills, the content and the result. */
export async function plannerPrompt(input: PlannerPromptInput): Promise<string> {
  const [toSpec, toTasks] = await Promise.all([
    readFile(path.join(SKILLS_SOURCE, "to-spec", "SKILL.md"), "utf8"),
    readFile(path.join(SKILLS_SOURCE, "to-tasks", "SKILL.md"), "utf8"),
  ]);
  const refs = input.refs ?? [];
  const hasRefs = refs.length > 0;
  const out = [
    "You are the planner of a graph-execution run. You run unattended: no human will read your questions or answer them.",
    "Never ask a question and never wait for approval. Where the skills below say to ask the user, to wait for approval,",
    "to commit, to start the run or to open graph-manager, do not: decide yourself and write down what you decided in the",
    "spec's Decisions table. Do not implement the change. Do not commit: the engine commits your files.",
    "Write only these files: `docs/prd/<name>.md`, the task files in `.agents/tasks/<name>/` (and",
    "`.agents/tasks/<name>/test-plan.json`), and the result file named at the end.",
    "",
    "## Skill: to-spec",
    "",
    toSpec.trimEnd(),
    "",
    "## Skill: to-tasks",
    "",
    toTasks.trimEnd(),
    "",
    "## How the skills apply here",
    "",
    "- Pick one kebab-case `<name>` for the plan: lowercase letters, digits and single hyphens.",
    `- Names already taken: ${input.taken.length > 0 ? input.taken.map((n) => `\`${n}\``).join(", ") : "none"}. When your name is taken, add \`-2\`, \`-3\`… to it.`,
    "- Write the spec to `docs/prd/<name>.md` and the tasks to `.agents/tasks/<name>/`, relative to your working directory (the run's integration worktree).",
    `- Check the task folder with \`node ${input.validateScript} .agents/tasks/<name>\` until it prints OK.`,
    "",
    "## Content",
    "",
    planContentPathLine(input.contentPath),
    "",
    fence(input.content),
    "",
    ...(hasRefs
      ? [
          "## Refs",
          "",
          ...(input.refsPath ? [planRefsPathLine(input.refsPath), ""] : []),
          ...refs.map(refLine),
          "",
          "The content describes these items. First decide, for each ref, whether it can be built as written, without a",
          "human answering a question. Plan only the ready refs, all in one spec and one task folder, and name each ready",
          "ref's ticket key in the spec's Goals. Do not plan a ref that is not ready: list it under notReady with the",
          "questions a human must answer.",
          "",
        ]
      : [
          "First decide whether the content can be built as written, without a human answering a question. If it cannot,",
          "write no spec and no tasks; write only the result file with `ready: false` and your questions.",
          "",
        ]),
    ...(input.previousError !== undefined
      ? [
          "## Previous attempt",
          "",
          `The engine rejected your previous attempt: ${input.previousError}. Fix the files (they are still in your working directory) and write the result file again.`,
          "",
        ]
      : []),
    ...(input.feedback.length > 0
      ? [
          "## Feedback on earlier plans",
          "",
          "A human rejected the earlier plan(s) with this feedback. Write a new plan that answers all of it.",
          "",
          ...(input.rejectedCommit !== undefined
            ? [`The last rejected plan is commit \`${input.rejectedCommit}\`: read it with \`git show ${input.rejectedCommit}\`.`, ""]
            : []),
          ...input.feedback.flatMap((text, i) => [`### Feedback ${i + 1}`, "", fence(text), ""]),
        ]
      : []),
    "## Result",
    "",
    ...(hasRefs
      ? [
          "When you are done, write a JSON object:",
          "",
          '`{"name": "<name>", "ready": ["<ready ref>", …], "notReady": [{"ref": "<ref>", "questions": ["<question>", …]}]}`',
          "",
          "Every ref appears exactly once, in `ready` or in `notReady`. Omit `name` when no ref is ready (and write no spec",
          "and no tasks then).",
        ]
      : [
          "When you are done, write a JSON object:",
          "",
          '- ready: `{"name": "<name>", "ready": true, "questions": []}`',
          '- not ready: `{"ready": false, "questions": ["<question>", …]}` (no `name`)',
        ]),
    "",
    planResultPathLine(input.resultPath),
  ];
  return out.join("\n");
}
