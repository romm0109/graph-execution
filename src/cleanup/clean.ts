import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/config.js";
import { repoRoot } from "../git/git.js";
import { EXIT_ABORT, EXIT_REVIEW_FAILED, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { execute } from "./execute.js";
import { formatSize } from "./format.js";
import { plan } from "./plan.js";
import { scan } from "./scan.js";

export interface CleanRunsOptions {
  cwd: string;
  runId?: string;
  yes?: boolean;
  done?: boolean;
  force?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

async function readlineConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** `graph-execution clean`: shows what would be deleted, asks, then deletes. */
export async function cleanRuns(opts: CleanRunsOptions): Promise<ExitCode> {
  const out = opts.out ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = opts.err ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const repo = await repoRoot(opts.cwd);
  const found = await scan(repo);
  const { keepRuns } = await loadConfig(repo);
  const p = await plan(found, { keepRuns, runId: opts.runId, includeDone: opts.done, force: opts.force });
  if (p.entries.length === 0) {
    out("Nothing to clean.");
    for (const s of p.skipped) out(`Skipped ${s.id}: ${s.reason}`);
    return EXIT_SUCCESS;
  }
  for (const e of p.entries) out(`${e.id}  ${e.reason}  ${formatSize(e.sizeBytes)}  ${e.branches.length} branches`);
  for (const s of p.skipped) out(`Skipped ${s.id}: ${s.reason}`);
  out(`Frees ${formatSize(p.totalBytes)}.`);
  if (!opts.yes) {
    if (!opts.confirm && !process.stdin.isTTY) {
      err("error: not a terminal; use --yes");
      return EXIT_ABORT;
    }
    if (!(await (opts.confirm ?? readlineConfirm)("Delete these? [y/N] "))) {
      out("Nothing deleted.");
      return EXIT_SUCCESS;
    }
  }
  const { failed } = await execute(repo, p, out);
  return failed > 0 ? EXIT_REVIEW_FAILED : EXIT_SUCCESS;
}
