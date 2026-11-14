import { createWriteStream } from "node:fs";
import { execa } from "execa";
import { REVIEWERS_ENV } from "../review/reviewers.js";
import { WEB_HOST_ENV, WEB_PORT_ENV, WEB_TOKEN_ENV } from "../state/paths.js";
import type { SuiteFeature } from "./state.js";

export interface FeatureProcess {
  pid: number;
  /** Resolves to the exit code; a child killed by a signal gives 2. */
  exited: Promise<number>;
  stop(): void;
}

/** `cwd`: the feature's repo in a multi-repo suite; the suite's repo when omitted. */
export type SpawnFeature = (args: string[], env: Record<string, string>, logFile: string, cwd?: string) => FeatureProcess;

export function featureArgs(
  f: Pick<SuiteFeature, "tasksDir" | "prd">,
  opts: { provider: string; model?: string; share: number; reviewers?: string },
): string[] {
  return [
    f.tasksDir,
    "--spec",
    f.prd,
    "--provider",
    opts.provider,
    ...(opts.model ? ["--model", opts.model] : []),
    "--concurrency",
    String(opts.share),
    ...(opts.reviewers ? ["--reviewers", opts.reviewers] : []),
    "--no-merge",
    "--no-human-review",
  ];
}

export function defaultSpawn(cliPath: string, cwd: string): SpawnFeature {
  return (args, env, logFile, featureCwd) => {
    const log = createWriteStream(logFile, { flags: "a" });
    const child = execa(process.execPath, [cliPath, ...args], {
      cwd: featureCwd ?? cwd,
      // Only the suite's copy counts: it is passed as --reviewers; the env var is blanked so a graph-manager setting cannot override it.
      // The suite page's listen address, token and ready file are the suite's own, never a feature run's.
      env: {
        ...process.env,
        ...env,
        [REVIEWERS_ENV]: "",
        [WEB_HOST_ENV]: undefined,
        [WEB_PORT_ENV]: undefined,
        [WEB_TOKEN_ENV]: undefined,
        GRAPH_EXECUTION_READY_FILE: undefined,
      },
      reject: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    const exited = (async () => {
      const res = await child;
      await new Promise<void>((resolve) => log.end(resolve));
      return res.signal || res.exitCode === undefined ? 2 : res.exitCode;
    })();
    return { pid: child.pid ?? 0, exited, stop: () => void child.kill("SIGTERM") };
  };
}
