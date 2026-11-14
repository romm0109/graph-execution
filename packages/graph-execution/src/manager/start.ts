// `graph-execution manager`: starts the bundled graph-manager (dist/manager/server, see scripts/bundle-manager.mjs)
// in this process. Nothing here imports manager code, fastify or node-pty statically: the other commands must not
// load them.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NODE_ENV_DEFAULTED } from "../env.js";
import { UsageError } from "../launch/preflight.js";
import { openInBrowser } from "../readme/readme.js";
import { EXIT_SUCCESS, type ExitCode } from "../state/errors.js";

/** The bundled manager's entry; compiled, this file is `dist/manager/start.js`, next to the bundle. */
export const MANAGER_MAIN = fileURLToPath(new URL("./server/main.js", import.meta.url));

/** The bundled manager's command line (`graph-execution manager users …`), next to `MANAGER_MAIN`. */
export const MANAGER_CLI = fileURLToPath(new URL("./server/cli.js", import.meta.url));

interface ManagerCliModule {
  main(argv: string[]): Promise<number | undefined>;
}

/**
 * `graph-execution manager users <command> …`: runs the bundled manager's `users` command (add, list, reset, disable)
 * against the same `GM_*` variables the server reads, and returns its exit code.
 */
export async function runManagerUsers(args: string[], deps: { cliFile?: string } = {}): Promise<ExitCode> {
  const cliFile = deps.cliFile ?? MANAGER_CLI;
  if (!existsSync(cliFile)) {
    throw new UsageError("graph-manager is not part of this build: run npm run build at the repository root");
  }
  // A computed specifier, as in runManager: the other commands must not load manager code.
  const mod = (await import(pathToFileURL(cliFile).href)) as ManagerCliModule;
  const code = await mod.main(["users", ...args]);
  return (code ?? EXIT_SUCCESS) as ExitCode;
}

/** How long `close()` may take after a signal: open browser connections can keep it waiting. */
const CLOSE_TIMEOUT_MS = 5000;

export interface ManagerOptions {
  port?: string;
  host?: string;
  dataDir?: string;
  workspacesDir?: string;
  /** commander's `--no-open`: false keeps the browser closed. */
  open?: boolean;
}

interface ManagerModule {
  startManager(env: NodeJS.ProcessEnv): Promise<{ url: string; close(): Promise<void> }>;
}

export interface ManagerDeps {
  mainFile?: string;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  open?: (url: string) => Promise<boolean>;
  /** Resolves when the manager must stop; default: the first SIGINT or SIGTERM. */
  stopped?: Promise<void>;
}

/**
 * Turns the flags into the manager's `GM_*` variables (a flag overrides the variable) and points it at this CLI.
 * The manager's terminals and runs inherit the environment, so the NODE_ENV=production this CLI defaulted for
 * itself is taken away again: `npm install` in a terminal would skip devDependencies.
 */
export function applyManagerEnv(opts: ManagerOptions, env: NodeJS.ProcessEnv, cliPath: string, nodeEnvDefaulted: boolean): void {
  if (opts.port !== undefined) env.GM_PORT = opts.port;
  if (opts.host !== undefined) env.GM_HOST = opts.host;
  if (opts.dataDir !== undefined) env.GM_DATA_DIR = opts.dataDir;
  if (opts.workspacesDir !== undefined) env.GM_WORKSPACES_DIR = opts.workspacesDir;
  if (!env.GM_GRAPH_EXECUTION_BIN) env.GM_GRAPH_EXECUTION_BIN = cliPath;
  if (nodeEnvDefaulted) delete env.NODE_ENV;
}

/** Whether to open the browser: not with `--no-open`, GRAPH_EXECUTION_NO_OPEN=1, without a terminal, or over SSH. */
export function shouldOpen(open: boolean | undefined, env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (open === false || env.GRAPH_EXECUTION_NO_OPEN === "1" || !isTTY) return false;
  return !(env.SSH_CONNECTION || env.SSH_TTY);
}

function firstSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/** Starts graph-manager and stays until it is stopped. 0 after a signal, 1 when it cannot start. */
export async function runManager(opts: ManagerOptions, deps: ManagerDeps = {}): Promise<ExitCode> {
  const mainFile = deps.mainFile ?? MANAGER_MAIN;
  const env = deps.env ?? process.env;
  if (!existsSync(mainFile)) {
    throw new UsageError("graph-manager is not part of this build: run npm run build at the repository root");
  }
  if (opts.port !== undefined && !(/^\d+$/.test(opts.port) && Number(opts.port) <= 65535)) {
    throw new UsageError(`invalid --port "${opts.port}": pass a number from 0 to 65535`);
  }
  applyManagerEnv(opts, env, deps.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url)), NODE_ENV_DEFAULTED);
  // Registered before the start, so a signal during it is not lost.
  const stopped = deps.stopped ?? firstSignal();
  // A computed specifier: a bare Windows path is not one, and a static import would load the manager for every command.
  const mod = (await import(pathToFileURL(mainFile).href)) as ManagerModule;
  let manager: { url: string; close(): Promise<void> };
  try {
    manager = await mod.startManager(env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (shouldOpen(opts.open, env, deps.isTTY ?? Boolean(process.stdout.isTTY))) {
    void (deps.open ?? openInBrowser)(manager.url).catch(() => false);
  }
  await stopped;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    manager.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return EXIT_SUCCESS;
}
