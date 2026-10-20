import { appendFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { UiOptions } from "../ui/start.js";
import { startWebUi, type WebUiHandle } from "./start.js";

const LAUNCH_DIR_PREFIX = "graph-execution-launch-";

/** `web.json` in a run folder: `{ url, pid }` while the run process lives. */
export const webJsonPath = (runDir: string): string => path.join(runDir, "web.json");

/** Appends `line` to `run.log` with a time prefix; the log is best effort. */
export function appendRunLog(runDir: string, line: string): void {
  try {
    appendFileSync(path.join(runDir, "run.log"), `${new Date().toTimeString().slice(0, 8)} ${line}\n`);
  } catch {
    // The page still has it.
  }
}

/**
 * The UI factory of the `--web-serve` process: starts the web view, announces it (`web.json`, the ready file the
 * launcher waits for), removes the one-shot wrapper script (the launcher removes its folder) and mirrors the log into `run.log`.
 */
export function webServeUi(env: NodeJS.ProcessEnv = process.env): {
  ui: (opts: UiOptions) => Promise<WebUiHandle>;
  handle(): WebUiHandle | undefined;
  runDir(): string | undefined;
} {
  let handle: WebUiHandle | undefined;
  let dir: string | undefined;
  return {
    handle: () => handle,
    runDir: () => dir,
    ui: async (opts) => {
      const web = await startWebUi(opts);
      const runDir = opts.runDir;
      dir = runDir;
      const wrapped: WebUiHandle = {
        ...web,
        log: (line) => {
          if (runDir) appendRunLog(runDir, line);
          web.log(line);
        },
      };
      handle = wrapped;
      if (runDir) await writeFile(webJsonPath(runDir), JSON.stringify({ url: web.url, pid: process.pid }));
      const readyFile = env.GRAPH_EXECUTION_READY_FILE;
      if (readyFile) {
        const tmp = `${readyFile}.tmp`;
        await writeFile(tmp, JSON.stringify({ url: web.url, runId: opts.runId, pid: process.pid }));
        await rename(tmp, readyFile);
        // The launcher still reads the ready file and removes the folder itself; the script has done its job.
        const dir = path.dirname(readyFile);
        if (path.basename(dir).startsWith(LAUNCH_DIR_PREFIX)) {
          await Promise.all(["run.sh", "run.cmd"].map((f) => rm(path.join(dir, f), { force: true })));
        }
      }
      if (process.platform === "win32" && env.GRAPH_EXECUTION_TASK_NAME) {
        await execa("schtasks", ["/delete", "/tn", env.GRAPH_EXECUTION_TASK_NAME, "/f"], {
          reject: false,
          stdio: "ignore",
        });
      }
      return wrapped;
    },
  };
}
