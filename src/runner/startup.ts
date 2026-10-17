import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Config, loadConfig } from "../config/config.js";
import { currentBranch, currentHead, ensureExcluded, isDirty, isRepo, repoRoot } from "../git/git.js";
import { getProvider } from "../providers/index.js";
import type { Provider } from "../providers/types.js";

export const RUNS_DIR = ".graph-execution";

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
  if (!(await isRepo(opts.cwd))) throw new Error(`not inside a git repository: ${opts.cwd}`);
  const repo = await repoRoot(opts.cwd);

  let startingCommit: string;
  try {
    startingCommit = await currentHead(repo);
  } catch {
    throw new Error("the repository has no commits yet; commit something before running");
  }

  const branch = await currentBranch(repo);
  const startBranch = branch === "HEAD" ? undefined : branch;

  const config = await loadConfig(repo);
  const provider = opts.providerInstance ?? (await getProvider(opts.provider, repo));

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

  const runId = generateRunId();
  const runDir = path.join(repo, RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  log("warning: agents run in full-auto mode with their worktree as cwd; this is not a sandbox, only run trusted tasks");
  return { repo, runId, runDir, startingCommit, ...(startBranch ? { startBranch } : {}), provider, config };
}
