import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { escapeCmd, quoteFor, quotePosix } from "./quote.js";

export interface LaunchScriptOptions {
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd: string;
  execPath: string;
  cliPath: string;
  /** Arguments without `--web`; `--web-serve` is appended. */
  args: string[];
  tmpRoot?: string;
  /** Scheduled task the run process deletes once ready (Windows); passed as `GRAPH_EXECUTION_TASK_NAME`. */
  taskName?: string;
}

export interface LaunchScript {
  dir: string;
  script: string;
  readyFile: string;
  logFile: string;
  /** POSIX scripts write the run process's PID here before starting it, so the launcher can see it die. */
  pidFile: string;
}

function launchEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  readyFile: string,
  taskName?: string,
): [string, string][] {
  const out: [string, string][] = [];
  const pathKey =
    platform === "win32"
      ? Object.keys(env).find((k) => k.toUpperCase() === "PATH")
      : "PATH";
  const pathValue = pathKey === undefined ? undefined : env[pathKey];
  if (pathValue !== undefined) out.push(["PATH", pathValue]);
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined || name === "GRAPH_EXECUTION_READY_FILE" || name === "GRAPH_EXECUTION_TASK_NAME") continue;
    if (name.startsWith("GRAPH_EXECUTION_")) out.push([name, value]);
  }
  for (const name of ["HOME", "USERPROFILE"]) {
    const value = env[name];
    if (value !== undefined) out.push([name, value]);
  }
  out.push(["GRAPH_EXECUTION_READY_FILE", readyFile]);
  if (taskName) out.push(["GRAPH_EXECUTION_TASK_NAME", taskName]);
  return out;
}

export async function writeLaunchScript(
  opts: LaunchScriptOptions,
): Promise<LaunchScript> {
  const platform = opts.platform ?? process.platform;
  const dir = await mkdtemp(
    path.join(opts.tmpRoot ?? tmpdir(), "graph-execution-launch-"),
  );
  await chmod(dir, 0o700);
  const readyFile = path.join(dir, "ready.json");
  const logFile = path.join(dir, "launch.log");
  const pidFile = path.join(dir, "run.pid");
  const q = (v: string) => quoteFor(platform, v);
  const command = [
    q(opts.execPath),
    q(opts.cliPath),
    ...opts.args.map(q),
    "--web-serve",
  ].join(" ");
  const redirect = `>> ${q(logFile)} 2>&1`;
  const vars = launchEnv(opts.env, platform, readyFile, opts.taskName);

  let name: string;
  let lines: string[];
  if (platform === "win32") {
    name = "run.cmd";
    lines = [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      ...vars.map(([k, v]) => `set "${k}=${escapeCmd(v)}"`),
      `cd /d ${q(opts.cwd)}`,
      `${command} ${redirect}`,
    ];
  } else {
    name = "run.sh";
    lines = [
      "#!/bin/sh",
      ...vars.map(([k, v]) => `export ${k}=${quotePosix(v)}`),
      `cd ${q(opts.cwd)} || exit 1`,
      `echo $$ > ${q(pidFile)}`,
      `exec ${command} ${redirect}`,
    ];
  }
  const script = path.join(dir, name);
  await writeFile(
    script,
    lines.join(platform === "win32" ? "\r\n" : "\n") +
      (platform === "win32" ? "\r\n" : "\n"),
    {
      mode: 0o700,
    },
  );
  return { dir, script, readyFile, logFile, pidFile };
}
