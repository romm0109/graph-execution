#!/usr/bin/env node
import { runAgentCli } from "./agent/cli.js";
import { usersCommand } from "./cli/users.js";
import { isMain } from "./is-main.js";
import { serveFromCommandLine } from "./main.js";

/** The subcommands of `graph-manager`: each gets the arguments after its name and returns the exit code. */
export const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  users: (argv) => usersCommand(argv, process.env),
};

export const USAGE = `usage: graph-manager [serve]        start the server (the GM_* variables configure it)
       graph-manager users <command>  manage the accounts (add, list, reset, disable)
       graph-manager agent --workspaces <dir> [--port <p>] [--host <h>]
                                      the workspace agent of a container (needs GM_AGENT_TOKEN)`;

/** Runs `graph-manager <argv>`; `serve` (or nothing) starts the server and keeps running. */
export async function main(argv: string[]): Promise<number | undefined> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "serve") {
    serveFromCommandLine(process.env);
    return undefined;
  }
  if (cmd === "agent") {
    // Keeps running until SIGINT/SIGTERM; a startup error rejects (printed, exit 1).
    const { close } = await runAgentCli(rest, process.env);
    const stop = (): void => {
      void close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return undefined;
  }
  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!run) {
    console.error(USAGE);
    return 2;
  }
  return run(rest);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== undefined) process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
