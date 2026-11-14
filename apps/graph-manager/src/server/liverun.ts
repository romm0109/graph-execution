import { readdir } from "node:fs/promises";
import path from "node:path";
import { readLock } from "graph-execution/api";
import type { AppContext } from "./app.js";
import type { UserStore } from "./store.js";

/**
 * Whether a run is live in the workspace (or the project folder; then `id` is `project~<id>`): a lock of this host held by a live pid, or a sandbox of this workspace
 * whose container is running. A lock written in a container (foreign) is never signalled: only its sandbox counts.
 */
export async function liveRunIn(ctx: AppContext, us: UserStore, home: { id: string; path: string }): Promise<boolean> {
  const runsDir = path.join(home.path, ".graph-execution");
  const sandboxLive = async (runDir: string): Promise<boolean> => ((await ctx.sandboxes?.pageOf(runDir).catch(() => undefined)) ?? null) !== null;
  for (const rec of Object.values(us.get().sandboxes)) {
    if (rec.workspace === home.id && (await sandboxLive(path.join(runsDir, rec.runId)))) return true;
  }
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(runsDir, e.name);
    const lock = await readLock(runDir).catch(() => undefined);
    if (!lock) continue;
    if (lock.foreign) {
      if (await sandboxLive(runDir)) return true;
      continue;
    }
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    }
  }
  return false;
}
