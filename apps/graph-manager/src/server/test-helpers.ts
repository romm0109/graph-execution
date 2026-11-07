import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { DataStore } from "./store.js";

/** A temp dir that `cleanup` removes. */
export async function tempDir(prefix = "gm-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A config pointing at temp dirs under `dir`. */
export function testConfig(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    password: "pw",
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    workspacesDir: path.join(dir, "ws"),
    githubApiUrl: "https://api.github.com",
    graphExecutionBin: "graph-execution",
    ...overrides,
  };
}

/** The `name=value` part of a response's first Set-Cookie header. */
export function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return header.split(";")[0] ?? "";
}

/** An app on temp dirs, already logged in: pass `cookie` in `headers`. */
export async function appWithLogin(overrides: Partial<Config> = {}): Promise<{
  app: FastifyInstance;
  cookie: string;
  config: Config;
  store: DataStore;
  cleanup: () => Promise<void>;
}> {
  const { dir, cleanup: rmDir } = await tempDir();
  const config = testConfig(dir, overrides);
  const store = await DataStore.open(config.dataDir);
  const app = await buildApp(config, { store, webDir: path.join(dir, "no-web"), viewCache: false });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  if (res.statusCode !== 204) throw new Error(`login failed: ${res.statusCode}`);
  return {
    app,
    cookie: cookieOf(res),
    config,
    store,
    cleanup: async () => {
      await app.close();
      await rmDir();
    },
  };
}
