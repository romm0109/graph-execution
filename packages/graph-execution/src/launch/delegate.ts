// Engine self-delegation: in a graph-manager terminal, any copy of graph-execution (`npx graph-execution`, a global
// npm install, `node_modules/.bin/graph-execution`) hands its arguments to graph-manager's own engine, so the agent
// there always runs the engine whose skills it was given. graph-manager sets GRAPH_EXECUTION_DELEGATE (its shim, which
// also handles `--sandbox`, or the engine cli.js) and GM_ENGINE_BIN (the engine cli.js).
// No process.exit here: cli.ts's setExitCode is the only place that sets the exit code.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:os";

/** Set on the delegated child: it runs in place even when it is another copy than GM_ENGINE_BIN. */
export const DELEGATED_ENV = "GRAPH_EXECUTION_DELEGATED";

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function isFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The script this engine (`selfCliPath`, its own cli.js) hands its arguments to, or undefined to run in place:
 * when GRAPH_EXECUTION_DELEGATE is an existing `.js` file, this is not already a delegated run, and this engine is not
 * GM_ENGINE_BIN itself.
 */
export function delegateTarget(env: NodeJS.ProcessEnv, selfCliPath: string): string | undefined {
  const target = env.GRAPH_EXECUTION_DELEGATE;
  if (!target || !target.endsWith(".js") || !isFile(target)) return undefined;
  if (env[DELEGATED_ENV] === "1") return undefined;
  const engine = env.GM_ENGINE_BIN;
  if (engine && real(engine) === real(selfCliPath)) return undefined;
  return target;
}

/** Runs `node <target> <args>` in the foreground and returns its exit code (128+n for a death by signal n). */
export function runDelegate(target: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // Ctrl+C reaches the child through the terminal's process group; this process waits for it.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const child = spawn(process.execPath, [target, ...args], { stdio: "inherit", env: { ...process.env, [DELEGATED_ENV]: "1" } });
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    child.on("error", (e) => {
      process.stderr.write(`error: ${e.message}\n`);
      done(2);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)));
  });
}
