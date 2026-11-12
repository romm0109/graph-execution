import { PROVIDERS } from "./providers.js";
import { splitArgs } from "./splitargs.js";
import { z } from "zod";

/** The Start run options (docs/prd/run-options.md). An absent field sends no flag: the repo config or the engine default decides. */
export const runOptionsSchema = z.strictObject({
  humanReview: z.boolean().optional(),
  merge: z.boolean().optional(),
  model: z.string().max(200).regex(/^[^\s-]\S*$/, "must be a model name").optional(),
  /** The reviewers' provider and model (--review-provider / --review-model); the fixer keeps the run's. */
  reviewProvider: z.enum(PROVIDERS).optional(),
  reviewModel: z.string().max(200).regex(/^[^\s-]\S*$/, "must be a model name").optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  attempts: z.number().int().min(1).optional(),
  fixPasses: z.number().int().min(0).optional(),
  validationRounds: z.number().int().min(0).optional(),
  validateAt: z.enum(["task", "end"]).optional(),
  validateParallel: z.boolean().optional(),
  idleTimeoutMinutes: z.number().min(0).optional(),
  extraArgs: z.string().max(4000).optional(),
});
export type RunOptionsBody = z.infer<typeof runOptionsSchema>;

/** The option flags, in the order the Start run drawer's preview prints them. */
export function optionArgs(o: RunOptionsBody): string[] {
  const args: string[] = [];
  if (o.merge === false) args.push("--no-merge");
  if (o.humanReview !== undefined) args.push(o.humanReview ? "--human-review" : "--no-human-review");
  if (o.model !== undefined) args.push("--model", o.model);
  if (o.reviewProvider !== undefined) args.push("--review-provider", o.reviewProvider);
  if (o.reviewModel !== undefined) args.push("--review-model", o.reviewModel);
  if (o.concurrency !== undefined) args.push("--concurrency", String(o.concurrency));
  if (o.attempts !== undefined) args.push("--attempts", String(o.attempts));
  if (o.fixPasses !== undefined) args.push("--fix-passes", String(o.fixPasses));
  if (o.validationRounds !== undefined) args.push("--validation-rounds", String(o.validationRounds));
  if (o.validateAt !== undefined) args.push("--validate-at", o.validateAt);
  if (o.validateParallel !== undefined) args.push(o.validateParallel ? "--validate-parallel" : "--no-validate-parallel");
  if (o.idleTimeoutMinutes !== undefined) args.push("--idle-timeout", String(o.idleTimeoutMinutes));
  return args;
}

/** Flags graph-manager sets itself (or that would make the CLI exit without starting a run). */
export const RESERVED_FLAGS = ["--web", "--web-serve", "--resume", "--run", "--spec", "--provider", "--review-provider", "--review-model", "--sandbox", "--reviewers", "--help", "-h", "--version", "-v"] as const;

export class ExtraArgsError extends Error {}

/** The extra arguments as words (shell-style quoting, nothing expanded); throws ExtraArgsError on a reserved flag or bad quoting. */
export function splitExtraArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  let words: string[];
  try {
    words = splitArgs(value, "extra arguments");
  } catch (err) {
    throw new ExtraArgsError(err instanceof Error ? err.message : String(err));
  }
  words.forEach((word, i) => {
    const name = word.startsWith("--") ? (word.split("=")[0] ?? word) : word;
    if ((RESERVED_FLAGS as readonly string[]).includes(name) || (i === 0 && !word.startsWith("-"))) {
      throw new ExtraArgsError(`extra arguments: ${name} is set by graph-manager`);
    }
  });
  return words;
}

/** The graph-execution argv for a Start run request. */
export function startArgs(body: { tasksDir: string; spec: string; provider: string; options?: RunOptionsBody }): string[] {
  const o = body.options ?? {};
  return [body.tasksDir, "--spec", body.spec, "--provider", body.provider, ...optionArgs(o), ...splitExtraArgs(o.extraArgs), "--web"];
}
