import { repoRoot } from "../git/git.js";
import { RUNS_DIR } from "../launch/preflight.js";
import { EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { formatAge, formatSize } from "./format.js";
import { type RunEntry, scan } from "./scan.js";

export interface ListRunsOptions {
  cwd: string;
  out?: (text: string) => void;
  now?: Date;
}

function statusText(r: RunEntry): string {
  if (r.kind === "live") return "running";
  return r.kind === "unfinished" ? "unfinished" : r.status;
}

function branchesText(r: RunEntry): string {
  if (r.type === "suite") {
    const n = r.features.length;
    const text = [r.branches.find((b) => b.startsWith("suite/")), `${n} feature${n === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    return r.pid !== undefined ? `${text}  (pid ${r.pid})` : text;
  }
  const main = r.branches.find((b) => b.startsWith("graph/"));
  const tasks = r.branches.filter((b) => b.startsWith("graph-task/")).length;
  const parts = [main, tasks > 0 ? `${tasks} task branch${tasks === 1 ? "" : "es"}` : undefined].filter(Boolean);
  const text = parts.join(", ");
  return r.pid !== undefined ? `${text}  (pid ${r.pid})` : text;
}

/** `graph-execution list`: a table of the runs and a summary of the leftover branches. */
export async function listRuns(opts: ListRunsOptions): Promise<ExitCode> {
  const out = opts.out ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const now = opts.now ?? new Date();
  const found = await scan(await repoRoot(opts.cwd));
  if (found.runs.length === 0) {
    out(`No runs in ${found.repo}/${RUNS_DIR}`);
  } else {
    const rows = [
      ["RUN", "STATUS", "AGE", "SIZE", "BRANCHES"],
      ...found.runs.map((r) => [r.id, statusText(r), formatAge(r.createdAt, now), formatSize(r.sizeBytes), branchesText(r)]),
    ];
    const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
    for (const row of rows) {
      out(row.map((cell, c) => (c === row.length - 1 ? cell : cell.padEnd(widths[c]! + 2))).join("").trimEnd());
    }
  }
  const graph = found.orphans.filter((b) => b.startsWith("graph/")).length;
  const task = found.orphans.length - graph;
  out(found.orphans.length === 0 ? "Orphan branches: none" : `Orphan branches: ${found.orphans.length} (graph/* ${graph}, graph-task/* ${task})`);
  return EXIT_SUCCESS;
}
