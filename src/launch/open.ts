import { readFile } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { repoRoot } from "../git/git.js";
import { openInBrowser } from "../readme/readme.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { findRun } from "../state/resume.js";
import { isAlive } from "../state/state.js";
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

export interface OpenRunOptions {
  cwd: string;
  /** The run to open; the latest run when omitted. */
  runId?: string;
  /** Opens `url`; resolves false when no browser could be opened. */
  open?: (url: string) => Promise<boolean>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** `graph-execution open`: opens the live page of a run started with `--web`, when its process is still alive. */
export async function openRun(opts: OpenRunOptions): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = opts.err ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const repo = await repoRoot(opts.cwd);
  const runDir = await findRun(repo, opts.runId).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.replace(/^no run (\S+ )?to resume in/, (_m, id: string | undefined) => (id ? `no run ${id.trim()} found in` : "no run found in")));
  });
  const id = path.basename(runDir);
  const web = await readWebJson(runDir);
  if (!web || !isAlive(web.pid)) {
    err(`run ${id} has no live page (it was closed or isn't running with --web)`);
    return EXIT_ABORT;
  }
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (!ssh && (await (opts.open ?? openInBrowser)(web.url).catch(() => false))) {
    out(`Opened run ${id}: ${web.url}`);
    return EXIT_SUCCESS;
  }
  out(`Run ${id}: ${web.url}`);
  if (ssh) {
    const port = new URL(web.url).port;
    out(`From your machine: ssh -L ${port}:127.0.0.1:${port} ${os.hostname()}, then open http://127.0.0.1:${port}/`);
  }
  return EXIT_SUCCESS;
}
