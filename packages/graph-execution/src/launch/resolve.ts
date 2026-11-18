import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyResolutionOffline, ResolutionError, resolutionSchema } from "../escalation/resolve.js";
import { repoRoot } from "../git/git.js";
import { EXIT_ABORT, EXIT_REVIEW_FAILED, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { WEB_TOKEN_ENV } from "../state/paths.js";
import { isAlive, LockError } from "../state/state.js";
import { WEB_TOKEN_HEADER } from "../web/server.js";
import { readWebJson } from "../web/webjson.js";
import { findPage } from "./open.js";

export interface RunCommandOptions {
  cwd: string;
  /** The run; the latest run or suite when omitted. */
  runId?: string;
  env?: NodeJS.ProcessEnv;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export interface ResolveCommandOptions extends RunCommandOptions {
  /** The resolution JSON file. */
  file: string;
}

export const stdoutLine = (text: string): void => void process.stdout.write(`${text}\n`);
export const stderrLine = (text: string): void => void process.stderr.write(`${text}\n`);

/** The run folder of `runId` (or the latest), refusing suites; a message when there is none. */
export async function findRunDir(opts: RunCommandOptions): Promise<{ runDir: string } | { error: string }> {
  try {
    const repo = await repoRoot(opts.cwd);
    const runDir = await findPage(repo, opts.runId, opts.env ?? process.env);
    const id = path.basename(runDir);
    if (id.startsWith("suite-")) return { error: `escalations are per run; ${id} is a suite` };
    return { runDir };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** `task 2 requeued`, `tasks 2, 1 requeued` or `nothing requeued`. */
const requeuedText = (ids: string[]): string =>
  ids.length === 0 ? "nothing requeued" : `${ids.length === 1 ? "task" : "tasks"} ${ids.join(", ")} requeued`;

/** The error of a refused answer from the run page, when the body is one. */
function pageError(body: unknown): { code: string; message: string } | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return { code: typeof code === "string" ? code : "error", message: typeof message === "string" ? message : "refused" };
}

/** Whether the run's state says it has ended (Ctrl+C, a failure or an abort), not that it is waiting. */
async function runEnded(runDir: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as { status?: unknown };
    return state.status === "aborted" || state.status === "failed";
  } catch {
    return false;
  }
}

/**
 * `graph-execution resolve`: hands a resolution to the live run through its page (`POST /escalations/resolve`), or
 * applies it to the stopped run's state under the run lock. 0 applied, 1 refused, 2 usage error or unknown run.
 */
export async function resolveCommand(opts: ResolveCommandOptions): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? stdoutLine;
  const err = opts.err ?? stderrLine;
  const found = await findRunDir(opts);
  if ("error" in found) {
    err(found.error);
    return EXIT_ABORT;
  }
  const { runDir } = found;
  const id = path.basename(runDir);

  let body: string;
  let raw: unknown;
  try {
    body = await readFile(path.resolve(opts.cwd, opts.file), "utf8");
    raw = JSON.parse(body);
  } catch (e) {
    err(`cannot read ${opts.file}: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_ABORT;
  }
  const parsed = resolutionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    err(`invalid resolution: ${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
    return EXIT_ABORT;
  }
  const ids = parsed.data.escalationIds.join(", ");

  // A live run applies the resolution in its own process: the CLI never writes its state.
  const web = await readWebJson(runDir);
  if (web && isAlive(web.pid)) {
    const token = env[WEB_TOKEN_ENV];
    try {
      const res = await fetch(new URL("escalations/resolve", web.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { [WEB_TOKEN_HEADER]: token } : {}) },
        body,
      });
      const answer: unknown = await res.json().catch(() => undefined);
      if (res.ok) {
        const requeued = (answer as { requeued?: unknown } | undefined)?.requeued;
        out(
          parsed.data.action === "abort"
            ? `resolved ${ids}: the run is aborted`
            : `resolved ${ids}: ${requeuedText(Array.isArray(requeued) ? requeued.map(String) : [])}`,
        );
        return EXIT_SUCCESS;
      }
      const refused = pageError(answer);
      // A run stopped with Ctrl+C keeps its page up (it waits for Close): the page has no run to hand the resolution
      // to, so it is applied to the stopped run's state like for a run without a page.
      const stopped = refused?.code === "not_waiting" && (await runEnded(runDir));
      if (!stopped && refused) {
        err(`refused (${refused.code}): ${refused.message}`);
        return EXIT_REVIEW_FAILED;
      }
      if (!stopped) {
        err(`run ${id}'s page answered ${res.status} ${res.statusText}`);
        return EXIT_ABORT;
      }
    } catch (e) {
      // The run may have exited between the check and the request: then it is stopped.
      if (isAlive(web.pid)) {
        err(`cannot reach run ${id}'s page at ${web.url}: ${e instanceof Error ? e.message : String(e)}`);
        return EXIT_ABORT;
      }
    }
  }

  try {
    const { resolution } = await applyResolutionOffline(runDir, raw);
    out(
      resolution.action === "abort"
        ? `resolved ${ids}; the run is aborted`
        : `resolved ${ids}; continue with graph-execution --resume --run ${id}`,
    );
    return EXIT_SUCCESS;
  } catch (e) {
    if (e instanceof ResolutionError) {
      err(`refused (${e.code}): ${e.message}`);
      return EXIT_REVIEW_FAILED;
    }
    if (e instanceof LockError) {
      err(
        web && isAlive(web.pid)
          ? `run ${id} is still stopping; close its run page (${web.url}) or try again`
          : `run ${id} is running but has no live page; resolve it on its run page`,
      );
      return EXIT_ABORT;
    }
    err(e instanceof Error ? e.message : String(e));
    return EXIT_ABORT;
  }
}
