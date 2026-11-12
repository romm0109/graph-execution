#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { isMain } from "./is-main.js";
import { resolvePassword } from "./password.js";
import { fixSpawnHelper } from "./pty-helper.js";
import { engineDirOf } from "./sandbox-tools.js";
import { syncSkills, userSkillRoots } from "./skills.js";
import { isEngineJs } from "./terminals.js";

/**
 * The address a browser on this machine opens. A wildcard host is not an address to connect to (`0.0.0.0` does not
 * load on Windows), so it becomes the loopback address of its family; an IPv6 address gets its brackets.
 */
export function browserUrl(host: string, port: number): string {
  let h = host;
  if (h === "0.0.0.0") h = "127.0.0.1";
  else if (h === "::" || h === "[::]") h = "::1";
  if (h.includes(":") && !h.startsWith("[")) h = `[${h}]`;
  return `http://${h}:${port}`;
}

/**
 * Starts graph-manager from the `GM_*` variables in `env` and prints its address and password. The returned `url`
 * is the one to open in a browser (`browserUrl`). Registers no signal
 * handlers: the caller stops it with `close()`. Throws `ConfigError` for a bad variable or a port in use.
 */
export async function startManager(env: NodeJS.ProcessEnv): Promise<{ url: string; close(): Promise<void> }> {
  const base = loadConfig(env);
  await mkdir(base.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(base.workspacesDir, { recursive: true });
  const pw = await resolvePassword(env, base.dataDir);
  const config: Config = { ...base, password: pw.password };
  if (!isEngineJs(config.graphExecutionBin)) {
    console.warn(
      'warning: graph-execution\'s engine was not found next to graph-manager; terminals use "graph-execution" from the PATH (set GM_GRAPH_EXECUTION_BIN)',
    );
  }
  // The agents in the terminals get this engine's skills, whatever version a workspace checks in.
  const engineDir = engineDirOf(config.graphExecutionBin);
  if (engineDir) {
    try {
      const { installed, kept } = await syncSkills(engineDir, userSkillRoots(env));
      for (const d of installed) console.log(`Installed the ${path.basename(d)} skill into ${d}`);
      for (const d of kept) console.log(`Kept ${d}: not installed by graph-manager, so it is not replaced`);
    } catch (err) {
      console.error(`cannot install the graph-execution skills: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  fixSpawnHelper();
  const app = await buildApp(config, { startSandboxes: true, homeDir: os.homedir() });
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    await app.close().catch(() => undefined);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new ConfigError(`port ${config.port} is already in use: pass --port or set GM_PORT`);
    }
    throw err;
  }
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  console.log(`graph-manager listening on http://${config.host}:${port}`);
  console.log(pw.source === "file" ? `Password: ${pw.password} (saved in ${pw.file})` : "Password: from GM_PASSWORD");
  return { url: browserUrl(config.host, port), close: () => app.close() };
}

// Run directly (`node dist/server/main.js`, `npm start`); `graph-execution manager` imports startManager instead.
if (isMain(import.meta.url)) {
  startManager(process.env).then(
    ({ close }) => {
      const stop = (): void => {
        void close().then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
