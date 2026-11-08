#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { engineDirOf } from "./sandbox-tools.js";
import { syncSkills, userSkillRoots } from "./skills.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.workspacesDir, { recursive: true });
  // The agents in the terminals get this engine's skills, whatever version a workspace checks in.
  const engineDir = engineDirOf(config.graphExecutionBin);
  if (engineDir) {
    try {
      const { installed, kept } = await syncSkills(engineDir, userSkillRoots());
      for (const d of installed) console.log(`Installed the ${path.basename(d)} skill into ${d}`);
      for (const d of kept) console.log(`Kept ${d}: not installed by graph-manager, so it is not replaced`);
    } catch (err) {
      console.error(`cannot install the graph-execution skills: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const app = await buildApp(config, { startSandboxes: true });
  await app.listen({ port: config.port, host: config.host });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  console.log(`graph-manager listening on http://${config.host}:${port}`);
  const stop = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
