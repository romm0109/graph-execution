import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { openInBrowser } from "../readme/readme.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { runsRoot } from "../state/paths.js";
import { isAlive } from "../state/state.js";
import { SUITE_FILE, suiteHome } from "../suite/state.js";
import { webJsonPath } from "../web/serve.js";
import path from "node:path";

const webJsonSchema = z.object({ url: z.string(), pid: z.number() });
export type WebJson = z.infer<typeof webJsonSchema>;

/** The `{ url, pid }` the run process wrote; undefined when the file is missing or invalid. */
export async function readWebJson(runDir: string): Promise<WebJson | undefined> {
  try {
    return webJsonSchema.parse(JSON.parse(await readFile(webJsonPath(runDir), "utf8")));
  } catch {
    return undefined;
  }
}

/** A run folder holds `state.json`, a suite folder (`suite-<id>`) holds `suite.json`. */
const isPageDir = (root: string, id: string): boolean =>
  existsSync(path.join(root, id, id.startsWith("suite-") ? SUITE_FILE : "state.json"));

/** The run or suite to open: `id`, or the newest of all runs and suites (suite ids sort by their timestamp too). */
async function findPage(repo: string, id: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  const root = runsRoot(repo, env);
  if (id !== undefined) {
    if (!isPageDir(root, id)) throw new Error(`no run or suite ${id} found in ${root}`);
    return path.join(root, id);
  }
  const stamp = (id: string): string => id.replace(/^suite-/, "");
  const ids = (await readdir(root).catch(() => [] as string[])).filter((id) => isPageDir(root, id)).sort((a, b) => stamp(a).localeCompare(stamp(b)));
  if (ids.length === 0) throw new Error(`no run or suite found in ${root}`);
  return path.join(root, ids.at(-1)!);
}

export interface OpenRunOptions {
  cwd: string;
  /** The run or suite to open; the latest of them when omitted. */
  runId?: string;
  /** Opens `url`; resolves false when no browser could be opened. */
  open?: (url: string) => Promise<boolean>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** `graph-execution open`: opens the live page of a run or suite started with `--web`, when its process is still alive. */
export async function openRun(opts: OpenRunOptions): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = opts.err ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const repo = await suiteHome(opts.cwd);
  const runDir = await findPage(repo, opts.runId, env);
  const id = path.basename(runDir);
  const noun = id.startsWith("suite-") ? "suite" : "run";
  const web = await readWebJson(runDir);
  if (!web || !isAlive(web.pid)) {
    err(`${noun} ${id} has no live page (it was closed or isn't running with --web)`);
    return EXIT_ABORT;
  }
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (!ssh && (await (opts.open ?? openInBrowser)(web.url).catch(() => false))) {
    out(`Opened ${noun} ${id}: ${web.url}`);
    return EXIT_SUCCESS;
  }
  out(`${noun === "suite" ? "Suite" : "Run"} ${id}: ${web.url}`);
  if (ssh) {
    const port = new URL(web.url).port;
    out(`From your machine: ssh -L ${port}:127.0.0.1:${port} ${os.hostname()}, then open http://127.0.0.1:${port}/`);
  }
  return EXIT_SUCCESS;
}
