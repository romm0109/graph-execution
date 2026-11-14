import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILE = "graph-execution.config.json";

/** `graph-execution.config.json` at the repo root (PRD §9). Unknown keys are rejected so typos are caught. */
export const configSchema = z.strictObject({
  /** Commands run once in every new task worktree before the agent starts, e.g. `npm ci`. */
  setup: z.array(z.string()).default([]),
  /** Gate commands run after each task (PRD §7.4). */
  validate: z.array(z.string()).default([]),
  /** Runs the `validate` commands all at once instead of one after another, reporting every failure together. */
  validateParallel: z.boolean().default(false),
  /**
   * `task`: the gate runs after each task and again on the integration branch before the review. `end`: only on the
   * integration branch, once every task is merged; task files' own `validate` lists are ignored.
   */
  validateAt: z.enum(["task", "end"]).default("task"),
  concurrency: z.number().int().min(1).optional(),
  attempts: z.number().int().min(1).default(3),
  validationRounds: z.number().int().min(0).default(3),
  fixPasses: z.number().int().min(0).default(3),
  /** Pause before applying the result so a human can review it in the web view (docs/prd/done/06). */
  humanReview: z.boolean().default(false),
  /** Suite: run the cross-feature reviewer, the e2e tester and the fixer after validation; false keeps only validation. */
  e2eReview: z.boolean().default(true),
  /** Applied runs kept by the automatic cleanup at run start; 0 keeps everything. */
  keepRuns: z.number().int().min(0).default(5),
  /**
   * Stops and retries an agent that keeps making the same tool call, or the same cycle of 2–3 calls, `repeats` times in
   * a row; the stop counts as a failed attempt. false never stops an agent for a loop.
   */
  loopDetection: z
    .union([z.literal(false), z.strictObject({ repeats: z.number().int().min(2).default(5) })])
    .default({ repeats: 5 }),
  /**
   * Stops and retries an agent that produces no output for this many minutes (it counts as a failed attempt).
   * Fractions are allowed; 0 never stops an agent for silence.
   */
  idleTimeoutMinutes: z.number().min(0).default(20),
  /** Planner rounds for a `--content` run: on an invalid result or task folder the planner gets the error and tries again. */
  planAttempts: z.number().int().min(1).default(3),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export const defaultConfig = (): Config => configSchema.parse({});

/** Config keys a run flag can override for one run (docs/prd/run-options.md). Saved in state.json as `overrides`. */
export const overridesSchema = z.object({
  attempts: z.number().int().min(1).optional(),
  fixPasses: z.number().int().min(0).optional(),
  validationRounds: z.number().int().min(0).optional(),
  validateAt: z.enum(["task", "end"]).optional(),
  validateParallel: z.boolean().optional(),
  idleTimeoutMinutes: z.number().min(0).optional(),
  planAttempts: z.number().int().min(1).optional(),
});
export type ConfigOverrides = z.infer<typeof overridesSchema>;

/** The flag of each overridable key, for messages and --help. */
export const OVERRIDE_FLAGS: Record<keyof ConfigOverrides, string> = {
  attempts: "--attempts",
  fixPasses: "--fix-passes",
  validationRounds: "--validation-rounds",
  validateAt: "--validate-at",
  validateParallel: "--validate-parallel",
  idleTimeoutMinutes: "--idle-timeout",
  planAttempts: "--plan-attempts",
};

/** The keys of `overrides` whose value is set (undefined ones dropped); `{}` for none. */
export function definedOverrides(overrides: ConfigOverrides | undefined): ConfigOverrides {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out as ConfigOverrides;
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => {
      const where = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `  ${where}${i.message}`;
    })
    .join("\n");
}

/** `{ ...config, ...overrides }` validated with `configSchema`; throws ConfigError naming the bad key. */
export function applyOverrides(config: Config, overrides: ConfigOverrides | undefined): Config {
  const defined = definedOverrides(overrides);
  if (Object.keys(defined).length === 0) return config;
  const result = configSchema.safeParse({ ...config, ...defined });
  if (!result.success) throw new ConfigError(`invalid run options:\n${formatIssues(result.error.issues)}`);
  return result.data;
}

/** Reads the config at the repo root; a missing file means all defaults, never an error. */
export async function loadConfig(repoRoot: string): Promise<Config> {
  const file = path.join(repoRoot, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const where = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `  ${where}${i.message}`;
    });
    throw new ConfigError(`invalid config ${file}:\n${issues.join("\n")}`);
  }
  return result.data;
}
