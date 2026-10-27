import { createHash } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TEST_PLAN_FILE } from "../graph/testPlan.js";

export const taskStatusSchema = z.enum(["pending", "running", "validating", "merging", "merged", "failed"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskStateSchema = z.object({
  status: taskStatusSchema,
  attempts: z.number().int().min(0),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  mergeCommit: z.string().optional(),
  /** The integration commit the current attempt's branch was cut from, for the change view. */
  baseSha: z.string().optional(),
  /** `--no-worktree`: the integration branch head when the task's current attempt started; resume resets to it. */
  base: z.string().optional(),
});
export type TaskState = z.infer<typeof taskStateSchema>;

export const runStatusSchema = z.enum(["running", "applied", "done", "failed", "aborted"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** sha256 of the inputs at run start; resume refuses when one of them changed (PRD §7.8, §9). Never updated. */
export const hashesSchema = z.object({
  /** Of `graph-execution.config.json`, or `''` when there is none. */
  config: z.string(),
  /** Of the task files' contents, concatenated in file-name order. */
  tasks: z.string(),
  spec: z.string(),
});
export type Hashes = z.infer<typeof hashesSchema>;

export const reviewStepSchema = z.enum(["validate", "review", "fix", "human", "done"]);
export type ReviewStep = z.infer<typeof reviewStepSchema>;

/** Where the review phase is (PRD §7.8: resume continues it from the saved round and step). */
export const reviewStateSchema = z.object({
  /** `validate`: the gate before round 0; `review`: review round `round`; `fix`: fix pass `round`. */
  phase: reviewStepSchema,
  round: z.number().int().min(0),
  /** Validation fix rounds used so far in the current fix pass, or in the gate before round 0 (`validate`). */
  validationRounds: z.number().int().min(0),
  /** Reports of review round `round` already written and valid. */
  reports: z.object({ code: z.string().optional(), tester: z.string().optional() }),
  /** Integration branch head when fix pass `round` started; resume drops anything the pass committed after it. */
  fixBase: z.string().optional(),
  /** Human review pauses so far; the current pause is round `humanRound` (1-based). */
  humanRound: z.number().int().min(0).default(0),
  /** Review round where the current `fixPasses` budget started (a later slice moves it after each human round). */
  budgetBase: z.number().int().min(0).default(0),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const initialReviewState = (): ReviewState => ({ phase: "validate", round: 0, validationRounds: 0, reports: {}, humanRound: 0, budgetBase: 0 });

/** `.graph-execution/<run-id>/state.json` */
export const stateSchema = z.object({
  runId: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  concurrency: z.number().int().min(1).optional(),
  startingCommit: z.string(),
  integrationBranch: z.string(),
  /** The branch the run started on, merged into once the review is clean; absent with `--no-merge` or a detached HEAD. */
  targetBranch: z.string().optional(),
  /** Pause for a human review before applying (config `humanReview`, or `--human-review` / `--no-human-review`). */
  humanReview: z.boolean().default(false),
  /**
   * Set by `--no-worktree`: the run works in the user's own checkout, on the integration branch, one task at a time.
   * `branch` is checked out again at the end; `untracked` are the untracked files that were there at the start, kept
   * out of git (and so out of commits and cleanups) while the run works there.
   */
  checkout: z.object({ branch: z.string(), untracked: z.array(z.string()) }).optional(),
  specPath: z.string(),
  tasksDir: z.string(),
  hashes: hashesSchema,
  tasks: z.record(z.string(), taskStateSchema),
  review: reviewStateSchema,
  /** Per fixer / gate fixer node, the integration commits its last pass started and ended at, for the change view. */
  fixRanges: z.record(z.string(), z.object({ from: z.string(), to: z.string().optional() })).optional(),
  createdAt: z.string(),
  /** How the run ended, or `running`. Missing in state files written before this field: treat as unfinished. */
  status: runStatusSchema.optional(),
});
export type RunState = z.infer<typeof stateSchema>;

/** Test hook: the process kills itself right after the n-th state save (resume tests, PRD §7.8). */
export const KILL_AT_ENV = "GRAPH_EXECUTION_KILL_AT";
let saves = 0;

/** Holds the run state and persists it atomically after every change. */
export class StateStore {
  /** Saves run one after another: parallel tasks share the same `.tmp` file. */
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    public state: RunState,
  ) {}

  static async load(file: string): Promise<StateStore> {
    return new StateStore(file, stateSchema.parse(JSON.parse(await readFile(file, "utf8"))));
  }

  /** Writes `state.json.tmp` then renames it over `state.json`, so readers never see a partial file. */
  save(): Promise<void> {
    const write = async (): Promise<void> => {
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(stateSchema.parse(this.state), null, 2)}\n`);
      await rename(tmp, this.path);
      if (++saves === Number(process.env[KILL_AT_ENV])) process.kill(process.pid, "SIGKILL");
    };
    const next = this.saving.then(write);
    this.saving = next.catch(() => undefined);
    return next;
  }

  async update(fn: (state: RunState) => void): Promise<void> {
    fn(this.state);
    await this.save();
  }
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** sha256 of a file's content, or `''` when it does not exist. */
async function hashFile(file: string): Promise<string> {
  try {
    return sha256(await readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** sha256 of the `*.json` files of `dir` (except `test-plan.json`) concatenated in file-name order (the files `loadTasks` reads). */
async function hashTasks(dir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== TEST_PLAN_FILE)
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  const hash = createHash("sha256");
  for (const name of names) hash.update(await readFile(path.join(dir, name)));
  return hash.digest("hex");
}

export async function computeHashes(configFile: string, tasksDir: string, specPath: string): Promise<Hashes> {
  const [config, tasks, spec] = await Promise.all([hashFile(configFile), hashTasks(tasksDir), hashFile(specPath)]);
  return { config, tasks, spec };
}

const HASH_NAMES: Record<keyof Hashes, string> = { config: "config file", tasks: "task folder", spec: "spec" };

/** The inputs whose hash differs, named for the user, e.g. `["spec"]`. */
export function changedInputs(saved: Hashes, current: Hashes): string[] {
  return (Object.keys(HASH_NAMES) as (keyof Hashes)[]).filter((k) => saved[k] !== current[k]).map((k) => HASH_NAMES[k]);
}

export const LOCK_FILE = "lock";

export class LockError extends Error {}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID holding the run's lock, or undefined when there is no lock, it is stale, or this process holds it. */
export async function lockHolder(runDir: string): Promise<number | undefined> {
  const pid = Number((await readFile(path.join(runDir, LOCK_FILE), "utf8").catch(() => "")).trim());
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : undefined;
}

/**
 * Takes the run's PID lock (`<runDir>/lock`) so two processes never drive the same run. A lock whose PID is dead is
 * stale and taken over; a live one fails. Returns the release function.
 */
export async function acquireLock(runDir: string): Promise<() => Promise<void>> {
  const file = path.join(runDir, LOCK_FILE);
  for (;;) {
    try {
      await writeFile(file, `${process.pid}\n`, { flag: "wx" });
      return async () => {
        await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
      throw new LockError(`run ${path.basename(runDir)} is locked by the running process ${pid}; wait for it or stop it`);
    }
    await rm(file, { force: true });
  }
}
