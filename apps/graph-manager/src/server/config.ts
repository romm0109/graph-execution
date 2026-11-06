import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export interface Config {
  password: string;
  port: number;
  host: string;
  dataDir: string;
  workspacesDir: string;
  githubApiUrl: string;
  graphExecutionBin: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The graph-execution CLI of the workspace package, or `graph-execution` on PATH when it can't be resolved. */
export function defaultGraphExecutionBin(): string {
  const pkg = resolveGraphExecutionPackage();
  return pkg ? path.join(path.dirname(pkg), "dist", "cli.js") : "graph-execution";
}

function resolveGraphExecutionPackage(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve("graph-execution/package.json"));
  } catch {
    // import.meta.resolve is missing under some loaders (vitest), and an `exports` map may hide package.json:
    // look in the node_modules dirs Node would search instead.
  }
  try {
    const require = createRequire(import.meta.url);
    for (const dir of require.resolve.paths("graph-execution") ?? []) {
      const file = path.join(dir, "graph-execution", "package.json");
      if (existsSync(file)) return realpathSync(file);
    }
  } catch {
    // fall through to PATH
  }
  return undefined;
}

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const envSchema = z.object({
  GM_PASSWORD: optional,
  GM_PORT: optional.pipe(z.coerce.number<string | undefined>().int().min(0).max(65535).optional()),
  GM_HOST: optional,
  GM_DATA_DIR: optional,
  GM_WORKSPACES_DIR: optional,
  GM_GITHUB_API_URL: optional,
  GM_GRAPH_EXECUTION_BIN: optional,
});

/** Reads the config from environment variables. Throws `ConfigError` when one is missing or invalid. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`invalid ${String(issue?.path[0] ?? "config")}: ${issue?.message ?? "invalid value"}`);
  }
  const e = parsed.data;
  if (e.GM_PASSWORD === undefined) throw new ConfigError("GM_PASSWORD is required");
  return {
    password: e.GM_PASSWORD,
    port: e.GM_PORT ?? 7420,
    host: e.GM_HOST ?? "127.0.0.1",
    dataDir: path.resolve(e.GM_DATA_DIR ?? path.join(os.homedir(), ".graph-manager")),
    workspacesDir: path.resolve(e.GM_WORKSPACES_DIR ?? path.join(os.homedir(), "graph-manager-workspaces")),
    githubApiUrl: (e.GM_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    graphExecutionBin: e.GM_GRAPH_EXECUTION_BIN ?? defaultGraphExecutionBin(),
  };
}
