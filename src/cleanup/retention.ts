import { formatSize } from "./format.js";
import { execute } from "./execute.js";
import { plan } from "./plan.js";
import { scan } from "./scan.js";

/**
 * Automatic cleanup at run start: deletes applied runs beyond the newest `keepRuns` (0 disables) and hints at
 * unfinished runs. Never throws; a failure is only a warning.
 */
export async function retainRuns(repo: string, keepRuns: number, log: (l: string) => void): Promise<void> {
  try {
    const s = await scan(repo);
    if (keepRuns > 0) {
      const p = await plan(s, { keepRuns, retentionOnly: true });
      if (p.entries.length > 0) {
        await execute(repo, p, () => {});
        const n = p.entries.length;
        log(`cleaned up ${n} old applied run${n === 1 ? "" : "s"} (${formatSize(p.totalBytes)}), keepRuns: ${keepRuns}`);
      }
    }
    const unfinished = s.runs.filter((r) => r.kind === "unfinished");
    if (unfinished.length > 0) {
      const n = unfinished.length;
      const total = unfinished.reduce((sum, r) => sum + r.sizeBytes, 0);
      log(`${n} unfinished run${n === 1 ? "" : "s"} use${n === 1 ? "s" : ""} ${formatSize(total)}, run graph-execution clean`);
    }
  } catch (err) {
    log(`warning: automatic cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
