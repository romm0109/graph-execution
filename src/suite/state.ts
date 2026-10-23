import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isRepo, repoRoot } from "../git/git.js";
import { RUNS_DIR } from "../state/paths.js";
import { reviewStateSchema } from "../state/state.js";

export const featureStatusSchema = z.enum(["queued", "running", "done", "failed", "stopped", "excluded"]);
export type FeatureStatus = z.infer<typeof featureStatusSchema>;

export const suiteFeatureSchema = z.object({
  /** Unique; from basename(tasksDir) restricted to [A-Za-z0-9_-], with a "-2" suffix on duplicates. */
  name: z.string(),
  /** Name of its entry in `repos`. */
  repo: z.string(),
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

/** One git repo that holds features of the suite. */
export const suiteRepoSchema = z.object({
  /** Unique; from basename(root) restricted to [A-Za-z0-9_-], with a "-2" suffix on duplicates. */
  name: z.string(),
  /** Git root of the repo. Empty only while an old `suite.json` is being read, until `SuiteStore.load` fills it. */
  root: z.string(),
  startingCommit: z.string(),
  /** Undefined on a detached HEAD. */
  startBranch: z.string().optional(),
  /** What the apply of `suite/<rid>` to this repo's checkout did; set once applied. */
  applied: z.object({ files: z.number(), conflicts: z.array(z.string()) }).optional(),
});
export type SuiteRepo = z.infer<typeof suiteRepoSchema>;

export const repoNameOf = (root: string): string => path.basename(root).replace(/[^A-Za-z0-9_-]/g, "-") || "repo";

/** A `suite.json` written before `repos` existed becomes one repo built from its top-level fields. */
function migrateSuite(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || "repos" in raw) return raw;
  const old = raw as Record<string, unknown>;
  const name = "repo";
  const features = Array.isArray(old.features)
    ? old.features.map((f: unknown) => (typeof f === "object" && f !== null ? { repo: name, ...f } : f))
    : old.features;
  return {
    ...old,
    features,
    repos: [{ name, root: "", startingCommit: old.startingCommit, startBranch: old.startBranch }],
  };
}

const suiteObjectSchema = z.object({
  suiteId: z.string(),
  status: suiteStatusSchema,
  provider: z.string(),
  model: z.string().optional(),
  concurrency: z.number().int().min(1),
  /** `repos[0]`'s. */
  startingCommit: z.string(),
  /** `repos[0]`'s; undefined on a detached HEAD. */
  startBranch: z.string().optional(),
  /** One entry per distinct feature repo, in first-seen order. */
  repos: z.array(suiteRepoSchema).min(1),
  merge: z.boolean(),
  /** Pause after the e2e phase for the human review in the web view. */
  humanReview: z.boolean().default(false),
  features: z.array(suiteFeatureSchema).min(2),
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
  /** Multi-repo suites: the port each repo's app should use in the e2e phase, picked once so a resume keeps them. */
  e2ePorts: z.record(z.string(), z.number().int()).optional(),
  /** What the single apply changed in the starting checkout. */
  applied: z.object({ files: z.number(), conflicts: z.array(z.string()) }).optional(),
  createdAt: z.string(),
});
export const suiteStateSchema = z.preprocess(migrateSuite, suiteObjectSchema);
export type SuiteState = z.output<typeof suiteStateSchema>;

/** Never `state.json`: the run lookup treats folders holding that file as runs. */
export const SUITE_FILE = "suite.json";

/** The git root of the launch folder when it is in a repo, else the folder itself. */
export const suiteHome = async (cwd: string): Promise<string> => ((await isRepo(cwd)) ? await repoRoot(cwd) : path.resolve(cwd));

export const suiteDirOf = (repo: string, suiteId: string): string => path.join(repo, RUNS_DIR, suiteId);
export const featureRunDir = (suiteDir: string, runId: string): string => path.join(suiteDir, "features", runId);

/** Holds the suite state and persists it atomically after every change. */
/** Parses a `suite.json`; an old one gets its repo root from the suite folder (`<repo>/.graph-execution/suite-<id>`). */
export function parseSuiteState(raw: unknown, suiteDir: string): SuiteState {
  const state = suiteStateSchema.parse(raw);
  const first = state.repos[0]!;
  if (first.root === "") {
    first.root = path.resolve(suiteDir, "..", "..");
    const old = first.name;
    first.name = repoNameOf(first.root);
    for (const f of state.features) if (f.repo === old) f.repo = first.name;
  }
  return state;
}

export class SuiteStore {
  /** Saves run one after another: they share the same `.tmp` file. */
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    public state: SuiteState,
  ) {}

  static async load(file: string): Promise<SuiteStore> {
    return new SuiteStore(file, parseSuiteState(JSON.parse(await readFile(file, "utf8")), path.dirname(file)));
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
