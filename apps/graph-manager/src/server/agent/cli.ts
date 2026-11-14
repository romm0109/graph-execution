// `graph-manager agent --port <p> --workspaces <dir> [--host <h>]`: the workspace agent of a session or run container.
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, defaultGraphExecutionBin } from "../config.js";
import { startAgent } from "./server.js";

export const AGENT_USAGE = "usage: graph-manager agent --workspaces <dir> [--port <port, default 7700>] [--host <address, default 0.0.0.0>]";
export const TOKEN_MESSAGE = "GM_AGENT_TOKEN is required (at least 32 characters)";

/** Starts the agent from the command line; throws ConfigError for a bad flag or a missing GM_AGENT_TOKEN. */
export async function runAgentCli(argv: string[], env: NodeJS.ProcessEnv): Promise<{ url: string; close(): Promise<void> }> {
  let values: { port?: string; workspaces?: string; host?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { port: { type: "string" }, workspaces: { type: "string" }, host: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new ConfigError(`${err instanceof Error ? err.message : String(err)}\n${AGENT_USAGE}`);
  }
  const port = values.port === undefined ? 7700 : Number(values.port);
  if (!/^\d+$/.test(values.port ?? "7700") || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`invalid --port: ${values.port ?? ""}\n${AGENT_USAGE}`);
  }
  if (!values.workspaces) throw new ConfigError(`--workspaces is required\n${AGENT_USAGE}`);
  const token = env.GM_AGENT_TOKEN;
  if (token === undefined || token.length < 32) throw new ConfigError(TOKEN_MESSAGE);
  // No child (git, the engine, shells) may inherit it.
  delete env.GM_AGENT_TOKEN;
  delete process.env.GM_AGENT_TOKEN;
  const host = values.host ?? "0.0.0.0";
  const agent = await startAgent({
    port,
    host,
    workspacesDir: path.resolve(values.workspaces),
    token,
    graphExecutionBin: env.GM_GRAPH_EXECUTION_BIN ?? defaultGraphExecutionBin(),
    loginHome: os.homedir(),
  }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new ConfigError(`port ${port} is already in use: pass --port`);
    throw err;
  });
  const realPort = new URL(agent.url).port;
  console.log(`graph-manager agent listening on http://${host.includes(":") ? `[${host}]` : host}:${realPort}`);
  return agent;
}
