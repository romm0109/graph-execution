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
  /** The Docker Engine API endpoint: a unix socket path or a Windows named pipe (`GM_DOCKER_SOCKET`, else `DOCKER_HOST`, else the platform default; see `defaultDockerSocket`). */
  dockerSocket?: string;
  /** The base image of the default sandbox recipe (`GM_SANDBOX_IMAGE`). */
  sandboxImage?: string;
  /** Overrides the Docker source of the workspaces folder: a volume name, or an absolute host path (`GM_SANDBOX_WORKSPACES_SOURCE`). */
  sandboxWorkspacesSource?: string;
  /** Where graph-manager fills the sandbox tools (`GM_SANDBOX_TOOLS_DIR`); default `/opt/gm-tools` in Docker, else `<dataDir>/sandbox-tools`. */
  sandboxToolsDir?: string;
  /** A Postgres URL (`GM_DATABASE_URL`); unset = SQLite in `<dataDir>/graph-manager.db`. */
  databaseUrl?: string;
  /** How users sign in (`GM_AUTH`): `users` = built-in accounts (default; `password` is an alias). */
  auth: "users" | "gateway";
  /** Whether anyone may create an account on the login page (`GM_SIGNUP`, default `closed`). */
  signup: "open" | "closed";
  /** Where `password` came from (set by main.ts): `file` = `<dataDir>/password`; `env` or unset = authoritative for `admin`. */
  passwordSource?: "env" | "file";
  /** The HS256 secret of the gateway's `X-GM-Identity` tokens and its bearer token (`GM_GATEWAY_SECRET`); required with `auth: "gateway"`. */
  gatewaySecret?: string;
  /** Where the UI's Log out goes in gateway mode (`GM_GATEWAY_LOGOUT_URL`). */
  gatewayLogoutUrl?: string;
  /** Where run archives go (`GM_BLOB_URL`, `s3://bucket/prefix`); unset = files under `<dataDir>/blobs/`. */
  blobUrl?: string;
  /** The most repositories (sessions) one user may have open at a time (`GM_MAX_SESSIONS`); unset = no limit. */
  maxSessions?: number;
  /** The most live run containers (hosted runs) one user may have at a time (`GM_MAX_RUN_CONTAINERS`); unset = no limit. */
  maxRunContainers?: number;
  /** Minutes without terminal input/output or live run after which a session ends by itself (`GM_SESSION_IDLE_MINUTES`); unset = never. */
  sessionIdleMinutes?: number;
  /** Where sessions run (`GM_SESSION_RUNTIME`): `auto` (default) = local with one account, Docker with two or more; `local`; `docker`. */
  sessionRuntime?: "auto" | "local" | "docker";
  /** ES module URLs of UI plugins the web UI imports after sign-in (`GM_UI_PLUGINS`): `https://` URLs or paths starting with `/`. */
  uiPlugins?: string[];
}

/** The config read from the environment; the password is resolved separately (`password.ts`). */
export type BaseConfig = Omit<Config, "password">;

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

/** The classic unix socket of the Docker daemon. */
const UNIX_DOCKER_SOCKET = "/var/run/docker.sock";
/** The named pipe Docker Desktop listens on, in the forward-slash form `net.connect` takes. */
const WINDOWS_DOCKER_PIPE = "//./pipe/docker_engine";

/**
 * The Docker Engine API endpoint to use: `GM_DOCKER_SOCKET`, else a `unix://` or `npipe://` `DOCKER_HOST`, else the
 * named pipe of Docker Desktop on Windows, else the first unix socket that exists (the classic one, then the two of
 * Docker Desktop under the home folder). Other `DOCKER_HOST` schemes (`tcp://`, `ssh://`) are ignored: a remote
 * daemon cannot see the workspaces folder.
 */
export function defaultDockerSocket(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  home: string = os.homedir(),
): string {
  const explicit = env.GM_DOCKER_SOCKET?.trim();
  if (explicit) return explicit;
  const host = env.DOCKER_HOST?.trim() ?? "";
  for (const scheme of ["unix://", "npipe://"]) {
    const rest = host.startsWith(scheme) ? host.slice(scheme.length).trim() : "";
    if (rest) return rest;
  }
  if (platform === "win32") return WINDOWS_DOCKER_PIPE;
  const candidates = [UNIX_DOCKER_SOCKET, path.posix.join(home, ".docker", "run", "docker.sock"), path.posix.join(home, ".docker", "desktop", "docker.sock")];
  return candidates.find((file) => exists(file)) ?? UNIX_DOCKER_SOCKET;
}

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const envSchema = z.object({
  GM_PORT: optional.pipe(z.coerce.number<string | undefined>().int().min(0).max(65535).optional()),
  GM_HOST: optional,
  GM_DATA_DIR: optional,
  GM_WORKSPACES_DIR: optional,
  GM_GITHUB_API_URL: optional,
  GM_GRAPH_EXECUTION_BIN: optional,
  GM_DOCKER_SOCKET: optional,
  GM_SANDBOX_IMAGE: optional,
  GM_SANDBOX_WORKSPACES_SOURCE: optional,
  GM_SANDBOX_TOOLS_DIR: optional,
  GM_AUTH: optional,
  GM_SIGNUP: optional,
  GM_GATEWAY_SECRET: optional,
  GM_GATEWAY_LOGOUT_URL: optional,
  GM_BLOB_URL: optional.refine((v) => v === undefined || v.startsWith("s3://"), "must start with s3://"),
  GM_MAX_SESSIONS: optional.pipe(z.coerce.number<string | undefined>().int().min(1).optional()),
  GM_MAX_RUN_CONTAINERS: optional.pipe(z.coerce.number<string | undefined>().int().min(1).optional()),
  GM_SESSION_RUNTIME: optional,
  GM_SESSION_IDLE_MINUTES: optional.pipe(z.coerce.number<string | undefined>().int().min(1).optional()),
  GM_UI_PLUGINS: optional,
  GM_DATABASE_URL: optional.refine((v) => v === undefined || /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://"),
});

function uiPluginUrl(v: string): boolean {
  if (v.startsWith("/")) return !v.startsWith("//");
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

function httpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Reads the config from environment variables. Throws `ConfigError` when one is invalid. `GM_PASSWORD` is not read here: see `resolvePassword`. */
export function loadConfig(env: NodeJS.ProcessEnv): BaseConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`invalid ${String(issue?.path[0] ?? "config")}: ${issue?.message ?? "invalid value"}`);
  }
  const e = parsed.data;
  const authMode = e.GM_AUTH?.trim().toLowerCase();
  if (authMode !== undefined && authMode !== "users" && authMode !== "password" && authMode !== "gateway") {
    throw new ConfigError('GM_AUTH must be "users" or "gateway"');
  }
  const auth = authMode === "gateway" ? "gateway" : "users";
  if (auth === "gateway") {
    if (e.GM_GATEWAY_SECRET === undefined) throw new ConfigError("GM_GATEWAY_SECRET is required when GM_AUTH=gateway");
    if (e.GM_GATEWAY_SECRET.length < 32) throw new ConfigError("GM_GATEWAY_SECRET must be at least 32 characters");
  }
  if (e.GM_GATEWAY_LOGOUT_URL !== undefined && !httpUrl(e.GM_GATEWAY_LOGOUT_URL)) {
    throw new ConfigError("GM_GATEWAY_LOGOUT_URL must be an absolute http(s) URL");
  }
  const signup = e.GM_SIGNUP?.trim().toLowerCase();
  if (signup !== undefined && signup !== "open" && signup !== "closed") throw new ConfigError('GM_SIGNUP must be "open" or "closed"');
  const runtime = e.GM_SESSION_RUNTIME?.trim().toLowerCase() ?? "auto";
  if (runtime !== "auto" && runtime !== "local" && runtime !== "docker") throw new ConfigError('GM_SESSION_RUNTIME must be "auto", "local" or "docker"');
  const uiPlugins = (e.GM_UI_PLUGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of uiPlugins) {
    if (!uiPluginUrl(entry)) throw new ConfigError(`GM_UI_PLUGINS entries must be https:// URLs or paths starting with /: ${entry}`);
  }
  const config: BaseConfig = {
    port: e.GM_PORT ?? 7420,
    host: e.GM_HOST ?? "127.0.0.1",
    dataDir: path.resolve(e.GM_DATA_DIR ?? path.join(os.homedir(), ".graph-manager")),
    workspacesDir: path.resolve(e.GM_WORKSPACES_DIR ?? path.join(os.homedir(), "graph-manager-workspaces")),
    githubApiUrl: (e.GM_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    graphExecutionBin: e.GM_GRAPH_EXECUTION_BIN ?? defaultGraphExecutionBin(),
    dockerSocket: defaultDockerSocket(env),
    auth,
    signup: signup === "open" ? "open" : "closed",
    sessionRuntime: runtime,
  };
  if (e.GM_SANDBOX_IMAGE !== undefined) config.sandboxImage = e.GM_SANDBOX_IMAGE;
  if (e.GM_SANDBOX_WORKSPACES_SOURCE !== undefined) config.sandboxWorkspacesSource = e.GM_SANDBOX_WORKSPACES_SOURCE;
  if (e.GM_SANDBOX_TOOLS_DIR !== undefined) config.sandboxToolsDir = path.resolve(e.GM_SANDBOX_TOOLS_DIR);
  if (e.GM_DATABASE_URL !== undefined) config.databaseUrl = e.GM_DATABASE_URL;
  if (e.GM_BLOB_URL !== undefined) config.blobUrl = e.GM_BLOB_URL;
  if (e.GM_GATEWAY_SECRET !== undefined) config.gatewaySecret = e.GM_GATEWAY_SECRET;
  if (e.GM_GATEWAY_LOGOUT_URL !== undefined) config.gatewayLogoutUrl = e.GM_GATEWAY_LOGOUT_URL;
  if (e.GM_MAX_SESSIONS !== undefined) config.maxSessions = e.GM_MAX_SESSIONS;
  if (e.GM_MAX_RUN_CONTAINERS !== undefined) config.maxRunContainers = e.GM_MAX_RUN_CONTAINERS;
  if (e.GM_SESSION_IDLE_MINUTES !== undefined) config.sessionIdleMinutes = e.GM_SESSION_IDLE_MINUTES;
  if (uiPlugins.length > 0) config.uiPlugins = uiPlugins;
  return config;
}
