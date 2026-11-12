import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ENGINE_PROVIDER_IDS } from "../providers/catalog.js";
import { DEFAULT_SANDBOX_BASE, FROM_ERROR, hasFromLine, IMAGE } from "../sandbox/image.js";

export const CONFIG_FILE = "graph-execution.config.json";

/** The `sandbox` section of the config. */
export function sandboxConfigSchema() {
  return z.strictObject({
    /** A ready-made image: skips the build; `base` and `dockerfile` are then unused. */
    image: z.string().regex(IMAGE, "not a valid image reference").optional(),
    /** The `FROM` of the generated Dockerfile: glibc, node >= 20, npm and git. */
    base: z.string().regex(IMAGE, "not a valid image reference").default(DEFAULT_SANDBOX_BASE),
    /** Extra Dockerfile lines after the CLI install, kept verbatim; no FROM. */
    dockerfile: z
      .array(z.string())
      .default([])
      .superRefine((lines, ctx) => {
        lines.forEach((line, i) => {
          if (hasFromLine(line)) ctx.addIssue({ code: "custom", message: FROM_ERROR, path: [i] });
        });
      }),
    cpus: z.number().positive().default(2),
    memoryMb: z.number().int().min(256).default(4096),
    pids: z.number().int().min(64).default(2048),
    /** Extra environment variable names passed into the container. */
    env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name")).default([]),
  });
}

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
  /**
   * Provider of every reviewer without its own `provider` in the reviewers file; `--review-provider` overrides it.
   * Unset: the run's `--provider`. The fixer always uses the run's provider.
   */
  reviewProvider: z.enum([...ENGINE_PROVIDER_IDS, "fake"] as unknown as [string, ...string[]]).optional(),
  /**
   * Model of every reviewer without its own `provider` or `model`; `--review-model` overrides it. Unset: the run's
   * `--model`. The fixer always uses the run's model.
   */
  reviewModel: z.string().trim().min(1).optional(),
  /** The standalone Docker sandbox (`--sandbox`, `graph-execution sandbox …`); run flags override it for one run. */
  sandbox: sandboxConfigSchema().optional(),
});

export type Config = z.infer<typeof configSchema>;

export type SandboxConfig = z.infer<ReturnType<typeof sandboxConfigSchema>>;

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
};

/** The keys of `overrides` whose value is set (undefined ones dropped); `{}` for none. */
export function definedOverrides(overrides: ConfigOverrides | undefined): ConfigOverrides {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out as ConfigOverrides;
}

export function formatIssues(issues: z.core.$ZodIssue[]): string {
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
    throw new ConfigError(`invalid config ${file}:\n${formatIssues(result.error.issues)}`);
  }
  return result.data;
}
