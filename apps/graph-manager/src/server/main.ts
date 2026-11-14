#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildApp } from "./app.js";
import { AlreadyRunningError, type BaseConfig, type Config, ConfigError, loadConfig } from "./config.js";
import { isMain } from "./is-main.js";
import { acquireStartLock, findRunning, removeLock, writeLock } from "./lock.js";
import { resolvePassword } from "./password.js";
import { fixSpawnHelper } from "./pty-helper.js";
import { engineDirOf } from "./sandbox-tools.js";
import { syncSkills, userSkillRoots } from "./skills.js";

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
 * is the one to open in a browser (`browserUrl`), and `port`, the port it listens on. Registers no signal
 * handlers: the caller stops it with `close()`. Throws `ConfigError` for a bad variable or a port in use (unless
 * `GM_PORT_FALLBACK=1`, which takes a free port instead), and `AlreadyRunningError` when another graph-manager runs on
 * the same data folder (`<dataDir>/server.lock`, written after `listen` and removed by `close()`).
 */
export async function startManager(env: NodeJS.ProcessEnv): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const base = loadConfig(env);
  await mkdir(base.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(base.workspacesDir, { recursive: true });
  // Held until server.lock is written: a second server starting at the same moment waits here, then finds this one.
  const releaseStart = await acquireStartLock(base.dataDir);
  try {
    return await startLocked(env, base);
  } finally {
    await releaseStart();
  }
}

async function startLocked(env: NodeJS.ProcessEnv, base: BaseConfig): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const running = await findRunning(base.dataDir);
  if (running) throw new AlreadyRunningError(running.port, running.pid);
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
  let app = await buildApp(config, { startSandboxes: true });
  let fellBack = false;
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || !config.portFallback) {
      await app.close().catch(() => undefined);
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new ConfigError(`port ${config.port} is already in use: pass --port or set GM_PORT`);
      }
      throw err;
    }
    fellBack = true;
    try {
      await app.listen({ port: 0, host: config.host });
    } catch {
      // Some fastify versions refuse a second listen after a failed one: start over with a fresh instance.
      await app.close().catch(() => undefined);
      app = await buildApp(config, { startSandboxes: true });
      try {
        await app.listen({ port: 0, host: config.host });
      } catch (err2) {
        await app.close().catch(() => undefined);
        throw err2;
      }
    }
  }
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  try {
    await writeLock(config.dataDir, { pid: process.pid, port, host: config.host, startedAt: new Date().toISOString() });
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
  if (fellBack) console.log(`port ${config.port} is in use, using ${port}`);
  console.log(`graph-manager listening on http://${config.host}:${port}`);
  console.log(pw.source === "file" ? `Password: ${pw.password} (saved in ${pw.file})` : "Password: from GM_PASSWORD");
  const server = app;
  const close = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      await removeLock(config.dataDir);
    }
  };
  return { url: browserUrl(config.host, port), port, close };
}

// Run directly (`node dist/server/main.js`, `npm start`); `graph-execution manager` imports startManager instead.
if (isMain(import.meta.url)) {
  // Only needed to launch this process under Electron (graph-manager desktop); it must not reach terminals, runs, agents or git hooks.
  delete process.env.ELECTRON_RUN_AS_NODE;
  startManager(process.env).then(
    ({ port, close }) => {
      // The desktop app forks this file with an IPC channel and waits for this message to learn the port.
      process.send?.({ type: "listening", port });
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void close().finally(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      // On Windows child.kill() ends the process without running a handler, so the desktop app asks over IPC
      // instead, and the lock is removed.
      if (process.send) {
        process.on("message", (m: unknown) => {
          if (m && typeof m === "object" && (m as { type?: unknown }).type === "shutdown") stop();
        });
      }
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      if (err instanceof AlreadyRunningError) {
        if (process.send) process.send({ type: "already-running", port: err.port, pid: err.pid }, () => process.exit(3));
        else process.exit(3);
        return;
      }
      process.exit(1);
    },
  );
}
