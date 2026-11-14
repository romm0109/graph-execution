import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { readProjectLinks } from "../cleanup/links.js";
import { repoRoot } from "../git/git.js";
import { openInBrowser } from "../readme/readme.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { runsRoot } from "../state/paths.js";
import { isAlive } from "../state/state.js";
import { SUITE_FILE } from "../suite/state.js";
import { readWebJson, type WebJson } from "../web/webjson.js";
import path from "node:path";

export { readWebJson, type WebJson };

/** A run folder holds `state.json`, a suite folder (`suite-<id>`) holds `suite.json`. */
const isPageDir = (root: string, id: string): boolean =>
  existsSync(path.join(root, id, id.startsWith("suite-") ? SUITE_FILE : "state.json"));

/** The run or suite to open: `id`, or the newest of all runs and suites (suite ids sort by their timestamp too). */
async function findPage(repo: string, id: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  const root = runsRoot(repo, env);
  if (id !== undefined) {
    if (isPageDir(root, id)) return path.join(root, id);
    // A multi-repo suite lives in its project folder; a member repo knows it from its link.
    const link = (await readProjectLinks(repo)).find((l) => l.suiteId === id);
    if (link) return link.suiteDir;
    throw new Error(`no run or suite ${id} found in ${root}`);
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
  const repo = await repoRoot(opts.cwd);
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
