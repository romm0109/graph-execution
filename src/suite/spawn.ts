import { createWriteStream } from "node:fs";
import { execa } from "execa";
import type { SuiteFeature } from "./state.js";

export interface FeatureProcess {
  pid: number;
  /** Resolves to the exit code; a child killed by a signal gives 2. */
  exited: Promise<number>;
  stop(): void;
}

export type SpawnFeature = (args: string[], env: Record<string, string>, logFile: string) => FeatureProcess;

export function featureArgs(
  f: Pick<SuiteFeature, "tasksDir" | "prd">,
  opts: { provider: string; model?: string; share: number },
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
    "--no-merge",
    "--no-human-review",
  ];
}

export function defaultSpawn(cliPath: string, cwd: string): SpawnFeature {
  return (args, env, logFile) => {
    const log = createWriteStream(logFile, { flags: "a" });
    const child = execa(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
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
