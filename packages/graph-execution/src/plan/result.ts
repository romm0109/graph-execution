import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PlanRef } from "../state/state.js";
import { PLAN_NAME_PATTERN } from "./paths.js";

const NAME_MESSAGE = "name must be kebab-case: lowercase letters, digits and single hyphens";
const planName = z.string().regex(PLAN_NAME_PATTERN, NAME_MESSAGE);

/** `<runDir>/plan/result.json` of a run without refs: the content is one unit, ready or not. */
export const unitResultSchema = z
  .object({
    name: planName.optional(),
    ready: z.boolean(),
    questions: z.array(z.string().min(1)).default([]),
  })
  .superRefine((r, ctx) => {
    if (r.ready && r.name === undefined) ctx.addIssue({ code: "custom", path: ["name"], message: "name is required when ready is true" });
    if (!r.ready && r.questions.length === 0) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "ready is false: list at least one question a human must answer" });
    }
  });

/** `<runDir>/plan/result.json` of a run with refs: which refs are ready and the questions for the others. */
export const refsResultSchema = z.object({
  name: planName.optional(),
  ready: z.array(z.string()),
  notReady: z.array(z.object({ ref: z.string(), questions: z.array(z.string().min(1)).min(1) })).default([]),
});

/** The planner's readiness, the same for both result shapes. */
export interface PlanReadiness {
  /** True: nothing can be built; the run ends `needs-info`. */
  nothingReady: boolean;
  /** The plan's name; set when something is ready. */
  name?: string;
  /** Refs that are not ready (empty without refs). */
  dropped: string[];
  /** The planner's questions, per ref (no `ref` without refs). */
  questions: { ref?: string; questions: string[] }[];
}

export type PlanResultRead = { ok: true; readiness: PlanReadiness } | { ok: false; error: string };

/** Checks a refs result against the run's refs; returns the first error text, or undefined. */
function checkRefs(result: z.infer<typeof refsResultSchema>, refs: PlanRef[]): string | undefined {
  const known = refs.map((r) => r.ref);
  const list = known.join(", ");
  const seen = new Set<string>();
  for (const ref of [...result.ready, ...result.notReady.map((n) => n.ref)]) {
    if (!known.includes(ref)) return `ref ${ref} is not one of the run's refs (${list})`;
    if (seen.has(ref)) return `ref ${ref} is listed twice: put it in ready or notReady, once`;
    seen.add(ref);
  }
  for (const ref of known) if (!seen.has(ref)) return `ref ${ref} is missing: put it in ready or notReady`;
  if (result.ready.length > 0 && result.name === undefined) return "name is required when ready is not empty";
  return undefined;
}

/** Reads and checks the planner's result file against the run's refs; never throws for a missing or bad file. */
export async function readPlanResult(file: string, refs: PlanRef[]): Promise<PlanResultRead> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { ok: false, error: `the planner wrote no result file at ${file}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (refs.length > 0) {
    const parsed = refsResultSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: `${file} is invalid: ${z.prettifyError(parsed.error)}` };
    const error = checkRefs(parsed.data, refs);
    if (error !== undefined) return { ok: false, error: `${file} is invalid: ${error}` };
    const { name, ready, notReady } = parsed.data;
    const nothingReady = ready.length === 0;
    return {
      ok: true,
      readiness: {
        nothingReady,
        ...(!nothingReady && name !== undefined ? { name } : {}),
        dropped: notReady.map((n) => n.ref),
        questions: notReady.map((n) => ({ ref: n.ref, questions: n.questions })),
      },
    };
  }
  const parsed = unitResultSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `${file} is invalid: ${z.prettifyError(parsed.error)}` };
  const { name, ready, questions } = parsed.data;
  if (!ready) return { ok: true, readiness: { nothingReady: true, dropped: [], questions: [{ questions }] } };
  return { ok: true, readiness: { nothingReady: false, name: name!, dropped: [], questions: [] } };
}
