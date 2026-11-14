import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { overridesSchema } from "../config/config.js";
import { windowsProcessCreated, windowsProcessImage } from "../providers/wintree.js";
import { TEST_PLAN_FILE } from "../graph/testPlan.js";
import { renameReplacing } from "../fs/rename.js";
import { SANDBOX_ENV, TAKE_LOCK_FROM_ENV } from "./paths.js";

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
  /** Of the run's copy of the reviewers file, or `''` when the run has none. */
  reviewers: z.string().default(""),
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
  reports: z.record(z.string(), z.string()),
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
  /** Config keys overridden by run flags (`--attempts`, …), as given; resume applies them over the config again. */
  overrides: overridesSchema.optional(),
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
  /** Set when the run was started in a graph-manager sandbox (KAN-88): it must be resumed in one too. */
  sandbox: z.object({ image: z.string() }).optional(),
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
      await renameReplacing(tmp, this.path);
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

export async function computeHashes(configFile: string, tasksDir: string, specPath: string, reviewersFile?: string): Promise<Hashes> {
  const [config, tasks, spec, reviewers] = await Promise.all([
    hashFile(configFile),
    hashTasks(tasksDir),
    hashFile(specPath),
    reviewersFile ? hashFile(reviewersFile) : Promise.resolve(""),
  ]);
  return { config, tasks, spec, reviewers };
}

const HASH_NAMES: Record<keyof Hashes, string> = { config: "config file", tasks: "task folder", spec: "spec", reviewers: "reviewers file" };

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

/** Lock files held by this process (resolved path → token of the acquisition holding it). */
const heldLocks = new Map<string, string>();

/** The host name this process writes into run locks and agent records (inside a container: the container's). */
export const lockHost = (): string => os.hostname();

/** The last lock line of a process in a graph-manager sandbox (`GRAPH_EXECUTION_SANDBOX=1`), informational. */
const SANDBOX_MARK = "sandbox";
/** Whether this process runs in a graph-manager sandbox: its locks and agent records are marked. */
export const inSandbox = (): boolean => process.env[SANDBOX_ENV] === "1";

interface ParsedLock {
  pid: number;
  token: string | undefined;
  /** When the lock was written, ms since the epoch; absent in older files. */
  written: number | undefined;
  host: string;
  /** Written on another host (e.g. a graph-manager sandbox): its pid means nothing here (KAN-88). */
  foreign: boolean;
}

/**
 * A lock file's content: `<pid>\n<token>\n<written ms>\n<host>\n[sandbox\n]`. Older files have fewer lines: `<pid>\n`,
 * `<pid>\n<token>\n`, `<pid>\n<token>\n<written ms>\n` (no host: this host), or the first KAN-88 format
 * `<pid>\n<token>\n<host>\n[sandbox\n]` (no time). Any lock whose host differs from this host is foreign.
 */
function parseLock(text: string): ParsedLock {
  const [first = "", second, third, fourth] = text.split("\n");
  const thirdTrim = third?.trim() ?? "";
  const asTime = Number(thirdTrim);
  const isTime = thirdTrim !== "" && Number.isFinite(asTime) && asTime > 0;
  const written = isTime ? asTime : undefined;
  const hostLine = isTime ? fourth?.trim() : thirdTrim;
  const host = hostLine || os.hostname();
  return { pid: Number(first.trim()), token: second?.trim() || undefined, written, host, foreign: host !== os.hostname() };
}

export interface LockInfo {
  pid: number;
  token?: string;
  host: string;
  /** Written on another host (e.g. a graph-manager sandbox): its pid means nothing here. */
  foreign: boolean;
}

/** The raw content of the run's lock, without a liveness check; undefined when there is none or it is malformed. */
export async function readLock(runDir: string): Promise<LockInfo | undefined> {
  const text = await readFile(path.join(runDir, LOCK_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const { pid, token, host, foreign } = parseLock(text);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, ...(token !== undefined ? { token } : {}), host, foreign };
}

/** Whether graph-manager allowed taking over the lock and agent records of `host` (its sandbox is gone). */
function takeOverAllowed(host: string): boolean {
  const from = process.env[TAKE_LOCK_FROM_ENV];
  return from !== undefined && from !== "" && from === host;
}

/** Clock slack for comparing a process's creation time with the time a lock was written, in ms. */
const CLOCK_SLACK_MS = 100;

/** Whether another live process has the lock's PID; it may be a later process that reused the PID. */
const otherLivePid = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid);

/**
 * Whether the lock's PID still is the process that wrote it. Windows reuses a dead process's PID right away (often
 * for the next git or node it starts). The owner existed when it wrote the lock, while a process that reused its PID
 * was created after the owner died, so a live PID only counts when it was created before the lock was written.
 * Asking Windows takes PowerShell (a second or more), so only `acquireLock` asks, once a lock file is in its way.
 * POSIX reuses PIDs rarely, and only after wrapping around: a live PID counts.
 */
async function lockOwnerAlive(pid: number, written: number | undefined): Promise<boolean> {
  if (!otherLivePid(pid)) return false;
  if (process.platform !== "win32" || written === undefined) return true;
  const created = await windowsProcessCreated(pid);
  if (created !== undefined) return created <= written + CLOCK_SLACK_MS;
  // Creation time unknown. Windows lists no such process: it exited (its PID can still answer kill(pid, 0) while a
  // handle to it is open). A lock is only ever written by node, so a PID now running anything else was reused.
  const image = await windowsProcessImage(pid);
  if (image === null) return false;
  return image === undefined || image === path.basename(process.execPath).toLowerCase();
}

/**
 * The PID holding the run's lock, or undefined when there is no lock, it is stale, or this process holds it. Cheap,
 * for listings and status checks: on Windows a reused PID can still look like the holder (see `lockOwnerAlive`). A
 * lock of another host is always held (its pid is never checked here) unless `GRAPH_EXECUTION_TAKE_LOCK_FROM` names
 * its host.
 */
export async function lockHolder(runDir: string): Promise<number | undefined> {
  const { pid, host, foreign } = parseLock(await readFile(path.join(runDir, LOCK_FILE), "utf8").catch(() => ""));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (foreign) return takeOverAllowed(host) ? undefined : pid;
  return otherLivePid(pid) ? pid : undefined;
}

/**
 * Takes the run's PID lock (`<runDir>/lock`, content `<pid>\n<token>\n<written ms>\n<host>\n`, plus `sandbox\n` in a
 * graph-manager sandbox) so two processes never drive the same run.
 * A lock of this host whose PID is dead, or whose PID is this process's but that this process does not hold (left by
 * an earlier process with the same PID), is stale and taken over; a live other PID fails with `LockError`. A lock of
 * another host is never stale and fails with `LockError`, unless `GRAPH_EXECUTION_TAKE_LOCK_FROM` names its host:
 * then it is taken over. A second acquisition
 * while this process still holds the lock (also a concurrent one) throws `LockError`. Returns the release function,
 * which removes the lock file only while it is still this acquisition's (its token) and is idempotent.
 */
export async function acquireLock(runDir: string): Promise<() => Promise<void>> {
  const file = path.resolve(runDir, LOCK_FILE);
  const name = path.basename(path.resolve(runDir));
  if (heldLocks.has(file)) throw new LockError(`run ${name} is already locked by this process; release it first`);
  const token = randomUUID();
  heldLocks.set(file, token); // reserved synchronously, before any await: a concurrent call is refused above
  try {
    for (;;) {
      try {
        await writeFile(file, `${process.pid}\n${token}\n${Date.now()}\n${os.hostname()}\n${inSandbox() ? `${SANDBOX_MARK}\n` : ""}`, { flag: "wx" });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const { pid, written, host, foreign } = parseLock(await readFile(file, "utf8").catch(() => ""));
      if (foreign) {
        if (!takeOverAllowed(host)) {
          throw new LockError(
            `run ${name} is locked by process ${pid} on host ${host} (e.g. a graph-manager sandbox); resume it from graph-manager`,
          );
        }
        await rm(file, { force: true }); // graph-manager checked that the sandbox is gone: stale
        continue;
      }
      if (await lockOwnerAlive(pid, written)) {
        throw new LockError(`run ${name} is locked by the running process ${pid}; wait for it or stop it`);
      }
      await rm(file, { force: true }); // dead PID, or our PID left by an earlier process: stale
    }
  } catch (err) {
    heldLocks.delete(file);
    throw err;
  }
  return async () => {
    if (heldLocks.get(file) !== token) return; // released already
    heldLocks.delete(file);
    const { token: onDisk } = parseLock(await readFile(file, "utf8").catch(() => ""));
    if (onDisk === token) await rm(file, { force: true });
  };
}
