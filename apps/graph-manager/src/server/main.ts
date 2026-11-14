#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildApp } from "./app.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { isMain } from "./is-main.js";
import { resolvePassword } from "./password.js";
import { fixSpawnHelper } from "./pty-helper.js";
import { engineDirOf } from "./sandbox-tools.js";
import { syncSkills, userSkillRoots } from "./skills.js";

/**
 * The address a browser on this machine opens. A wildcard host is not an address to connect to (`0.0.0.0` does not
 * load on Windows), so it becomes the loopback address of its family; an IPv6 address gets its brackets.
 */
export function browserUrl(host: string, port: number, scheme: "http" | "https" = "http"): string {
  let h = host;
  if (h === "0.0.0.0") h = "127.0.0.1";
  else if (h === "::" || h === "[::]") h = "::1";
  if (h.includes(":") && !h.startsWith("[")) h = `[${h}]`;
  return `${scheme}://${h}:${port}`;
}

/** Reads the TLS pair once; a file that can't be read is a `ConfigError` naming it. */
async function readTls(tls: { certFile: string; keyFile: string }): Promise<{ cert: Buffer; key: Buffer }> {
  const read = async (file: string, what: string): Promise<Buffer> => {
    try {
      return await readFile(file);
    } catch (err) {
      throw new ConfigError(`cannot read ${what} ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return { cert: await read(tls.certFile, "TLS certificate"), key: await read(tls.keyFile, "TLS key") };
}

/**
 * Starts graph-manager from the `GM_*` variables in `env` and prints its address and password. The returned `url`
 * is the one to open in a browser (`browserUrl`). Registers no signal
 * handlers: the caller stops it with `close()`. Throws `ConfigError` for a bad variable or a port in use.
 */
export async function startManager(env: NodeJS.ProcessEnv): Promise<{ url: string; close(): Promise<void> }> {
  const base = loadConfig(env);
  const https = base.tls ? await readTls(base.tls) : undefined;
  await mkdir(base.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(base.workspacesDir, { recursive: true });
  const pw = await resolvePassword(env, base.dataDir);
  const config: Config = { ...base, password: pw.password };
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
  // A readable file that is not a PEM certificate or key makes Node's TLS throw, in Fastify(...) or in listen.
  const tlsError = (err: unknown): unknown =>
    https && !(err instanceof ConfigError) ? new ConfigError(`invalid TLS certificate or key: ${err instanceof Error ? err.message : String(err)}`) : err;
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp(config, { startSandboxes: true, ...(https ? { https } : {}) });
  } catch (err) {
    throw tlsError(err);
  }
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    await app.close().catch(() => undefined);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new ConfigError(`port ${config.port} is already in use: pass --port or set GM_PORT`);
    }
    throw tlsError(err);
  }
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const scheme = config.tls ? "https" : "http";
  console.log(`graph-manager listening on ${scheme}://${config.host}:${port}`);
  console.log(pw.source === "file" ? `Password: ${pw.password} (saved in ${pw.file})` : "Password: from GM_PASSWORD");
  return { url: browserUrl(config.host, port, scheme), close: () => app.close() };
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
