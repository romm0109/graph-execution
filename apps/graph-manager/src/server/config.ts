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
  /** Extension services shown in the nav and proxied at /ext/<name>/ (`GM_EXTENSIONS`). */
  extensions?: Extension[];
  /** Sent to every extension as X-GM-Extension-Secret (`GM_EXTENSION_SECRET`); set whenever `extensions` is. */
  extensionSecret?: string;
}

/** An extension service (`GM_EXTENSIONS`): its UI is an iframe of `/ext/<name>/`, which graph-manager proxies to `url`. */
export interface Extension {
  /** ^[a-z][a-z0-9-]{0,31}$ */
  name: string;
  /** http(s) origin plus an optional base path, without a trailing slash: "http://jira:8080", "http://h:9000/base" */
  url: string;
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
  GM_EXTENSIONS: optional,
  GM_EXTENSION_SECRET: optional,
});

const EXTENSION_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Parses `GM_EXTENSIONS` (`name=url,name=url`). Throws `ConfigError` naming the variable when an item is invalid. */
export function parseExtensions(value: string): Extension[] {
  const out: Extension[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    const eq = item.indexOf("=");
    if (eq === -1) throw new ConfigError(`invalid GM_EXTENSIONS: "${item}" is not name=url`);
    const name = item.slice(0, eq).trim();
    const url = item.slice(eq + 1).trim();
    if (!EXTENSION_NAME.test(name)) throw new ConfigError(`invalid GM_EXTENSIONS: name "${name}" must match ^[a-z][a-z0-9-]{0,31}$`);
    if (out.some((e) => e.name === name)) throw new ConfigError(`invalid GM_EXTENSIONS: duplicate name "${name}"`);
    let u: URL | undefined;
    try {
      u = new URL(url);
    } catch {
      u = undefined;
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) {
      throw new ConfigError(`invalid GM_EXTENSIONS: "${url}" is not an http(s) URL for ${name}`);
    }
    out.push({ name, url: u.origin + u.pathname.replace(/\/+$/, "") });
  }
  return out;
}

/** Reads the config from environment variables. Throws `ConfigError` when one is invalid. `GM_PASSWORD` is not read here: see `resolvePassword`. */
export function loadConfig(env: NodeJS.ProcessEnv): BaseConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`invalid ${String(issue?.path[0] ?? "config")}: ${issue?.message ?? "invalid value"}`);
  }
  const e = parsed.data;
  const config: BaseConfig = {
    port: e.GM_PORT ?? 7420,
    host: e.GM_HOST ?? "127.0.0.1",
    dataDir: path.resolve(e.GM_DATA_DIR ?? path.join(os.homedir(), ".graph-manager")),
    workspacesDir: path.resolve(e.GM_WORKSPACES_DIR ?? path.join(os.homedir(), "graph-manager-workspaces")),
    githubApiUrl: (e.GM_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    graphExecutionBin: e.GM_GRAPH_EXECUTION_BIN ?? defaultGraphExecutionBin(),
    dockerSocket: defaultDockerSocket(env),
  };
  if (e.GM_SANDBOX_IMAGE !== undefined) config.sandboxImage = e.GM_SANDBOX_IMAGE;
  if (e.GM_SANDBOX_WORKSPACES_SOURCE !== undefined) config.sandboxWorkspacesSource = e.GM_SANDBOX_WORKSPACES_SOURCE;
  if (e.GM_SANDBOX_TOOLS_DIR !== undefined) config.sandboxToolsDir = path.resolve(e.GM_SANDBOX_TOOLS_DIR);
  if (e.GM_EXTENSIONS !== undefined) {
    const extensions = parseExtensions(e.GM_EXTENSIONS);
    if (extensions.length > 0 && e.GM_EXTENSION_SECRET === undefined) {
      throw new ConfigError("GM_EXTENSIONS is set but GM_EXTENSION_SECRET is not: set GM_EXTENSION_SECRET to the secret the extension services expect");
    }
    config.extensions = extensions;
    if (e.GM_EXTENSION_SECRET !== undefined) config.extensionSecret = e.GM_EXTENSION_SECRET;
  }
  return config;
}
