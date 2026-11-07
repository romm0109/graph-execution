import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GraphError } from "./errors.js";

export const TEST_PLAN_FILE = "test-plan.json";
export const priorities = z.enum(["must", "should"]);
export const testCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  expected: z.string().min(1),
  priority: priorities,
});
export const testPlanSchema = z.object({ cases: z.array(testCaseSchema).min(1) });
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestPlan = z.infer<typeof testPlanSchema>;
export type Priority = z.infer<typeof priorities>;

/** Reads `test-plan.json` from `tasksDir`; `undefined` when there is none. Throws a `GraphError` listing every problem. */
export async function loadTestPlan(tasksDir: string): Promise<TestPlan | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(tasksDir, TEST_PLAN_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new GraphError([`${TEST_PLAN_FILE}: invalid JSON: ${(err as Error).message}`]);
  }

  const parsed = testPlanSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new GraphError([`${TEST_PLAN_FILE}: invalid test plan: ${issues}`]);
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const { id } of parsed.data.cases) {
    if (seen.has(id) && !reported.has(id)) {
      reported.add(id);
      problems.push(`${TEST_PLAN_FILE}: duplicate case id "${id}"`);
    }
    seen.add(id);
  }
  if (problems.length > 0) throw new GraphError(problems);
  return parsed.data;
}
