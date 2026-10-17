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
  concurrency: z.number().int().min(1).optional(),
  attempts: z.number().int().min(1).default(3),
  validationRounds: z.number().int().min(0).default(3),
  fixPasses: z.number().int().min(0).default(3),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export const defaultConfig = (): Config => configSchema.parse({});

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
