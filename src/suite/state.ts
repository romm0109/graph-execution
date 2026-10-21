import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RUNS_DIR } from "../state/paths.js";
import { reviewStateSchema } from "../state/state.js";

export const featureStatusSchema = z.enum(["queued", "running", "done", "failed", "stopped", "excluded"]);
export type FeatureStatus = z.infer<typeof featureStatusSchema>;

export const suiteFeatureSchema = z.object({
  /** Unique; from basename(tasksDir) restricted to [A-Za-z0-9_-], with a "-2" suffix on duplicates. */
  name: z.string(),
  tasksDir: z.string(),
  prd: z.string(),
  /** Pre-generated; the run folder is `<suiteDir>/features/<runId>`. */
  runId: z.string(),
  status: featureStatusSchema,
  share: z.number().int().min(1).optional(),
  pid: z.number().int().optional(),
  exitCode: z.number().int().optional(),
  finishedAt: z.string().optional(),
});
export type SuiteFeature = z.infer<typeof suiteFeatureSchema>;

export const suiteStatusSchema = z.enum(["running", "integrating", "applied", "done", "failed", "aborted"]);
export type SuiteStatus = z.infer<typeof suiteStatusSchema>;

export const suiteStateSchema = z.object({
  suiteId: z.string(),
  status: suiteStatusSchema,
  provider: z.string(),
  model: z.string().optional(),
  concurrency: z.number().int().min(1),
  startingCommit: z.string(),
  /** Undefined on a detached HEAD. */
  startBranch: z.string().optional(),
  merge: z.boolean(),
  /** Pause after the e2e phase for the human review in the web view. */
  humanReview: z.boolean().default(false),
  features: z.array(suiteFeatureSchema).min(2),
  /** `suite/<rid>`, once the integration started. */
  integrationBranch: z.string().optional(),
  /** `merged` holds feature names in merge order; `failed` is the feature whose merge the agent could not resolve. */
  integration: z.object({ merged: z.array(z.string()), failed: z.string().optional() }).default({ merged: [] }),
  /** Progress of the e2e phase on `suite/<rid>`, so `suite --resume` continues it. */
  review: reviewStateSchema.optional(),
  /** What the single apply changed in the starting checkout. */
  applied: z.object({ files: z.number(), conflicts: z.array(z.string()) }).optional(),
  createdAt: z.string(),
});
export type SuiteState = z.infer<typeof suiteStateSchema>;

/** Never `state.json`: the run lookup treats folders holding that file as runs. */
export const SUITE_FILE = "suite.json";

export const suiteDirOf = (repo: string, suiteId: string): string => path.join(repo, RUNS_DIR, suiteId);
export const featureRunDir = (suiteDir: string, runId: string): string => path.join(suiteDir, "features", runId);

/** Holds the suite state and persists it atomically after every change. */
export class SuiteStore {
  /** Saves run one after another: they share the same `.tmp` file. */
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    public state: SuiteState,
  ) {}

  static async load(file: string): Promise<SuiteStore> {
    return new SuiteStore(file, suiteStateSchema.parse(JSON.parse(await readFile(file, "utf8"))));
  }

  save(): Promise<void> {
    const write = async (): Promise<void> => {
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(suiteStateSchema.parse(this.state), null, 2)}\n`);
      await rename(tmp, this.path);
    };
    const next = this.saving.then(write);
    this.saving = next.catch(() => undefined);
    return next;
  }

  async update(fn: (state: SuiteState) => void): Promise<void> {
    fn(this.state);
    await this.save();
  }
}
