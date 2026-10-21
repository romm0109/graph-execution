import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { retainRuns } from "../cleanup/retention.js";
import type { Config } from "../config/config.js";
import { ensureExcluded, isDirty } from "../git/git.js";
import { assertNotNested, checkEnvironment, RUNS_DIR, UsageError } from "../launch/preflight.js";
import { RUN_ID_ENV, RUN_ID_PATTERN, runsRoot } from "../state/paths.js";
import type { Provider } from "../providers/types.js";

export { assertNotNested, RUNS_DIR };

export interface RunContext {
  repo: string;
  runId: string;
  /** `<repo>/.graph-execution/<run-id>` */
  runDir: string;
  startingCommit: string;
  /** The branch checked out when the run started; undefined on a detached HEAD. */
  startBranch?: string;
  provider: Provider;
  /** `graph-execution.config.json` at the repo root, or all defaults. */
  config: Config;
}

export interface StartupOptions {
  cwd: string;
  provider: string;
  /** Overrides provider lookup (tests inject a fake provider instance). */
  providerInstance?: Provider;
  /**
   * Paths the run hands to the agents itself (the spec and the task folder): their uncommitted changes need no
   * warning.
   */
  references?: readonly string[];
  log?: (line: string) => void;
  /** Environment holding `GRAPH_EXECUTION_RUNS_ROOT` and `GRAPH_EXECUTION_RUN_ID`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDD-HHMMSS-<4 hex>` in local time. */
export function generateRunId(now = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/** Startup checks of PRD §7.11 that need git and the provider; spec and graph are checked by the CLI before. */
export async function startup(opts: StartupOptions): Promise<RunContext> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const env = opts.env ?? process.env;
  const forced = env[RUN_ID_ENV];
  if (forced !== undefined && !RUN_ID_PATTERN.test(forced)) throw new UsageError(`invalid ${RUN_ID_ENV}: ${forced}`);
  const { repo, startingCommit, startBranch, config, provider } = await checkEnvironment(opts);

  await ensureExcluded(repo, `${RUNS_DIR}/`);
  const ignore = (opts.references ?? [])
    .map((p) => path.resolve(opts.cwd, p))
    .map((p) => path.relative(repo, existsSync(p) ? realpathSync(p) : p))
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));
  if (await isDirty(repo, ignore)) {
    log(
      "warning: the working tree has uncommitted changes; agents will not see them (worktrees are cut from committed " +
        "state), and changes to tracked files keep the result from being applied to your branch at the end",
    );
  }

  await retainRuns(repo, config.keepRuns, log);

  const runId = forced ?? generateRunId();
  const runDir = path.join(runsRoot(repo, env), runId);
  if (existsSync(path.join(runDir, "state.json"))) {
    throw new UsageError(`run ${runId} already exists in ${path.dirname(runDir)}`);
  }
  await mkdir(runDir, { recursive: true });

  log("warning: agents run in full-auto mode with their worktree as cwd; this is not a sandbox, only run trusted tasks");
  return { repo, runId, runDir, startingCommit, ...(startBranch ? { startBranch } : {}), provider, config };
}
