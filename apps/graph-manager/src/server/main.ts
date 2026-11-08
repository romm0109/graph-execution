#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

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
