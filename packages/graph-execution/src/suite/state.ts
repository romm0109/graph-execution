import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RUNS_DIR } from "../state/paths.js";
import { reviewStateSchema } from "../state/state.js";
import { renameReplacing } from "../fs/rename.js";

export const featureStatusSchema = z.enum(["queued", "running", "done", "failed", "stopped", "excluded"]);
export type FeatureStatus = z.infer<typeof featureStatusSchema>;

/** A repo of a multi-repo suite: where it was when the suite started. */
export const suiteRepoSchema = z.object({
  name: z.string(),
  /** Absolute, with links resolved. */
  path: z.string(),
  startingCommit: z.string(),
  /** Undefined on a detached HEAD. */
  startBranch: z.string().optional(),
});
export type SuiteRepo = z.infer<typeof suiteRepoSchema>;

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
  /** Multi-repo suite only: the repo this feature runs in. */
  repo: suiteRepoSchema.optional(),
});
export type SuiteFeature = z.infer<typeof suiteFeatureSchema>;

/** One run of the integration agent on a conflicted merge: the conflicted files and how far it got. */
export const integrationAgentSchema = z.object({
  files: z.array(z.string()),
  attempt: z.number().int().min(1),
  attempts: z.number().int().min(1),
  status: z.enum(["running", "resolved", "failed"]),
});
export type IntegrationAgent = z.infer<typeof integrationAgentSchema>;

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
  /** At least 2 in a single-repo suite (`validateSuite`); a project may change one repo. */
  features: z.array(suiteFeatureSchema).min(1),
  /** Multi-repo suite only: the project folder (the suite's home) and its contract. */
  project: z.object({ dir: z.string(), name: z.string(), contract: z.string() }).optional(),
  /** Multi-repo suite only: every repo of the project in `project.json` order, with what the apply changed in it. */
  repos: z
    .array(suiteRepoSchema.extend({ applied: z.object({ files: z.number(), conflicts: z.array(z.string()) }).optional() }))
    .optional(),
  /** Set when the suite was started inside a graph-manager sandbox (`GRAPH_EXECUTION_SANDBOX=1`); its image. */
  sandbox: z.object({ image: z.string() }).optional(),
  /** Why the integration, e2e or joint phase gave up (`<step>: <message>`), while the suite is `failed` for it. */
  error: z.string().optional(),
  /** `suite/<rid>`, once the integration started. */
  integrationBranch: z.string().optional(),
  /**
   * `merged` holds feature names in merge order; `failed` is the feature whose merge the agent could not resolve;
   * `agents` has the integration agent's last run per feature whose merge conflicted (its output is in
   * `logs/integration-<name>.log`).
   */
  integration: z
    .object({ merged: z.array(z.string()), failed: z.string().optional(), agents: z.record(z.string(), integrationAgentSchema).optional() })
    .default({ merged: [] }),
  /** Progress of the e2e phase on `suite/<rid>`, so `suite --resume` continues it. */
  review: reviewStateSchema.optional(),
  /** What the single apply changed in the starting checkout. */
  applied: z.object({ files: z.number(), conflicts: z.array(z.string()) }).optional(),
  /** Multi-repo suites: the joint phase's base heads and each repo's last validation result, for the page and resume. */
  joint: z
    .object({
      /** Each repo's `suite/<rid>` head when the joint phase first started: the base of the joint fixer's changes. */
      base: z.record(z.string(), z.string()),
      validation: z
        .array(
          z.object({
            repo: z.string(),
            ok: z.boolean(),
            commands: z.number().int().min(0),
            command: z.string().optional(),
            exitCode: z.number().int().optional(),
            at: z.string(),
          }),
        )
        .default([]),
    })
    .optional(),
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
      await renameReplacing(tmp, this.path);
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
