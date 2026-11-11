// The `graph-execution sandbox build|dockerfile|config` commands.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE, type Config, ConfigError, configSchema, formatIssues, loadConfig, sandboxConfigSchema } from "../config/config.js";
import { repoRoot } from "../git/git.js";
import { UsageError } from "../launch/preflight.js";
import { build, DOCKER_MISSING, dockerAvailable, type Exec, imageExists, pull } from "./docker.js";
import { resolveImage } from "./image.js";
import { resolveSandboxSettings, type SandboxFlags } from "./settings.js";

export interface ImageCommandOptions {
  cwd: string;
  providers: string[];
  image?: string;
  base?: string;
  lines: string[];
  noCache?: boolean;
  print?: (line: string) => void;
  exec?: Exec;
}

/** The config at the repo root, or the defaults outside a git repo. */
async function configAt(cwd: string): Promise<Pick<Config, "sandbox">> {
  const root = await repoRoot(cwd).catch(() => undefined);
  return root ? loadConfig(root) : {};
}

function flagsOf(o: ImageCommandOptions): SandboxFlags {
  return {
    ...(o.image !== undefined ? { sandboxImage: o.image } : {}),
    ...(o.base !== undefined ? { sandboxBase: o.base } : {}),
    sandboxLine: o.lines,
  };
}

/** `sandbox dockerfile`: prints the Dockerfile and its tag; never runs docker. */
export async function printDockerfile(o: ImageCommandOptions): Promise<void> {
  const print = o.print ?? ((l: string) => console.log(l));
  const settings = resolveSandboxSettings(await configAt(o.cwd), flagsOf(o), false);
  const resolved = resolveImage({ base: settings.base, lines: settings.lines }, o.providers);
  if (resolved.kind !== "build") throw new Error("unreachable");
  print(resolved.dockerfile.replace(/\n$/, ""));
  print(`# tag: ${resolved.tag}`);
}

/** `sandbox build`: builds the image (or reuses its tag), or checks / pulls a ready-made one. Resolves with the image. */
export async function buildImage(o: ImageCommandOptions): Promise<string> {
  const print = o.print ?? ((l: string) => console.log(l));
  const settings = resolveSandboxSettings(await configAt(o.cwd), flagsOf(o), false);
  const docker = { cwd: o.cwd, ...(o.exec ? { exec: o.exec } : {}) };
  if (!(await dockerAvailable(docker))) throw new UsageError(DOCKER_MISSING);
  const resolved = resolveImage(settings, o.providers);
  if (resolved.kind === "ready") {
    if (!(await imageExists(resolved.image, docker))) await pull(resolved.image, { ...docker, onLine: print });
    print(`Sandbox image: ${resolved.image}`);
    return resolved.image;
  }
  if (!o.noCache && (await imageExists(resolved.tag, docker))) {
    print(`Reusing the existing image (--no-cache to rebuild).`);
  } else {
    try {
      await build(resolved.dockerfile, resolved.tag, { ...docker, noCache: o.noCache ?? false, onLine: print });
    } catch (err) {
      const hint = "the base image needs glibc, node >= 20, npm and git";
      throw new Error(`building the sandbox image failed; ${hint}\n${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  print(`Sandbox image: ${resolved.tag}`);
  return resolved.tag;
}

export interface ConfigCommandOptions {
  cwd: string;
  image?: string;
  base?: string;
  lines: string[];
  clearLines?: boolean;
  cpus?: number;
  memory?: number;
  pids?: number;
  unsetImage?: boolean;
  print?: (line: string) => void;
}

/** `sandbox config`: edits the `sandbox` section of the config at the repo root, or prints it with the defaults. */
export async function editSandboxConfig(o: ConfigCommandOptions): Promise<void> {
  const print = o.print ?? ((l: string) => console.log(l));
  if (o.image !== undefined && o.base !== undefined) throw new UsageError("--image and --base cannot be used together");
  if (o.image !== undefined && o.unsetImage) throw new UsageError("--image and --unset-image cannot be used together");
  const root = await repoRoot(o.cwd).catch(() => {
    throw new UsageError("sandbox config must run inside a git repository");
  });
  const file = path.join(root, CONFIG_FILE);
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`invalid config ${file}: not a JSON object`);
    }
    raw = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
    }
  }
  const changes =
    o.image !== undefined || o.base !== undefined || o.lines.length > 0 || o.clearLines || o.unsetImage ||
    o.cpus !== undefined || o.memory !== undefined || o.pids !== undefined;
  const current = raw.sandbox;
  if (!changes) {
    const result = sandboxConfigSchema().safeParse(current ?? {});
    if (!result.success) throw new ConfigError(`invalid config ${file}:\n${formatIssues(result.error.issues.map((i) => ({ ...i, path: ["sandbox", ...i.path] })))}`);
    print(JSON.stringify(result.data, null, 2));
    if (current === undefined) print(`(defaults: ${CONFIG_FILE} has no sandbox section)`);
    return;
  }
  const section: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  if (o.image !== undefined) section.image = o.image;
  if (o.unsetImage) delete section.image;
  if (o.base !== undefined) section.base = o.base;
  if (o.clearLines || o.lines.length > 0) {
    const before = o.clearLines || !Array.isArray(section.dockerfile) ? [] : (section.dockerfile as unknown[]);
    section.dockerfile = [...before, ...o.lines];
  }
  if (o.cpus !== undefined) section.cpus = o.cpus;
  if (o.memory !== undefined) section.memoryMb = o.memory;
  if (o.pids !== undefined) section.pids = o.pids;
  const next = { ...raw, sandbox: section };
  const result = configSchema.safeParse(next);
  if (!result.success) throw new UsageError(`invalid config ${file}:\n${formatIssues(result.error.issues)}`);
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  print(JSON.stringify(section, null, 2));
  print(`Saved the sandbox section of ${file}.`);
  const lines = result.data.sandbox?.dockerfile ?? [];
  if (result.data.sandbox?.image && lines.length > 0) {
    print("warning: sandbox.image is a ready-made image, so sandbox.base and sandbox.dockerfile are unused");
  }
  print("Note: --resume of a run started before this change refuses the changed config file.");
}
