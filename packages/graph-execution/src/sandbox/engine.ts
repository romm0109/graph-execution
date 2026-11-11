// The engine copy a sandbox container mounts read-only: the running package (package.json, dist/, skills/, sandbox/,
// README.md) and its production dependencies, flat in node_modules, copied once per version into the cache.
// Ported from graph-manager's apps/graph-manager/src/server/sandbox-tools.ts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renameReplacing } from "../fs/rename.js";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
}

/** The running engine package: `../..` from both `src/sandbox/` and `dist/sandbox/`. */
export function runningEngineDir(): string {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

/** `$GRAPH_EXECUTION_CACHE_DIR`, else `$XDG_CACHE_HOME/graph-execution`, else `~/.cache/graph-execution`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GRAPH_EXECUTION_CACHE_DIR) return path.resolve(env.GRAPH_EXECUTION_CACHE_DIR);
  if (env.XDG_CACHE_HOME) return path.join(path.resolve(env.XDG_CACHE_HOME), "graph-execution");
  return path.join(homedir(), ".cache", "graph-execution");
}

/** The engine package folder of an absolute `…/dist/cli.js`, when that folder is the graph-execution package. */
export function engineDirOf(bin: string): string | undefined {
  if (!path.isAbsolute(bin) || path.basename(bin) !== "cli.js" || path.basename(path.dirname(bin)) !== "dist") return undefined;
  const dir = path.dirname(path.dirname(bin));
  try {
    return readPackageJson(dir).name === "graph-execution" ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** `<version>-<mtime of dist/cli.js>`: a rebuilt engine gets a new copy. */
export function engineVersion(engineDir: string): string {
  const version = readPackageJson(engineDir).version ?? "unknown";
  const mtime = Math.floor(statSync(path.join(engineDir, "dist", "cli.js")).mtimeMs);
  return `${version}-${mtime}`;
}

/** The first `<dir>/node_modules/<name>` with a package.json, walking up from `fromDir`. */
function resolvePackage(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Copies with symlinks resolved (workspace and global installs are symlinks); skips `node_modules/.bin`. */
function copyTree(src: string, dest: string): Promise<void> {
  return cp(src, dest, {
    recursive: true,
    dereference: true,
    filter: (f) => !(path.basename(f) === ".bin" && path.basename(path.dirname(f)) === "node_modules"),
  });
}

function depsOf(pkg: PackageJson): { name: string; optional: boolean }[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
  ];
}

/**
 * Copies the production dependency closure of the package at `pkgDir` flat into `destModules`. Packages found inside
 * trees already copied (with their nested node_modules) are not placed again, only traversed.
 */
async function copyDependencies(pkgDir: string, destModules: string): Promise<void> {
  const roots: string[] = [];
  const placed = new Set<string>();
  const visited = new Set<string>();
  const startDir = await realpath(pkgDir);
  const queue: { name: string; optional: boolean; fromDir: string }[] = depsOf(readPackageJson(startDir)).map((d) => ({
    ...d,
    fromDir: startDir,
  }));
  for (let item = queue.shift(); item; item = queue.shift()) {
    const found = resolvePackage(item.name, item.fromDir);
    if (!found) {
      if (item.optional) continue;
      throw new Error(`cannot find ${item.name} for the sandbox engine copy`);
    }
    const real = await realpath(found);
    if (visited.has(real)) continue;
    visited.add(real);
    if (!roots.some((r) => isInside(real, r)) && !placed.has(item.name)) {
      placed.add(item.name);
      const target = path.join(destModules, item.name);
      if (!existsSync(target)) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyTree(real, target);
      }
      roots.push(real);
    }
    for (const d of depsOf(readPackageJson(real))) queue.push({ ...d, fromDir: real });
  }
}

/** Copies the engine package and its production dependencies into `dest`. */
export async function copyEngine(engineDir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of ["package.json", "dist", "skills", "sandbox", "README.md"]) {
    const src = path.join(engineDir, entry);
    if (existsSync(src)) await copyTree(src, path.join(dest, entry));
    else if (entry === "package.json" || entry === "dist") throw new Error(`${src} is missing`);
  }
  await copyDependencies(engineDir, path.join(dest, "node_modules"));
}

/**
 * The engine copy for the running version, made when missing or incomplete: built aside in `.next-<hex>` and renamed
 * into place, with its VERSION file written last. Resolves with the folder.
 */
export async function ensureEngineCopy(
  opts: { engineDir?: string; cacheDir?: string; log?: (line: string) => void } = {},
): Promise<string> {
  const engineDir = opts.engineDir ?? runningEngineDir();
  const version = engineVersion(engineDir);
  const parent = path.join(opts.cacheDir ?? cacheDir(), "sandbox-engine");
  const dir = path.join(parent, version);
  const versionFile = path.join(dir, "VERSION");
  try {
    if (readFileSync(versionFile, "utf8") === version) return dir;
  } catch {
    // Missing or incomplete: copy.
  }
  await mkdir(parent, { recursive: true });
  const next = path.join(parent, `.next-${randomBytes(4).toString("hex")}`);
  try {
    await copyEngine(engineDir, next);
    const tmp = path.join(next, "VERSION.tmp");
    await writeFile(tmp, version);
    await renameReplacing(tmp, path.join(next, "VERSION"));
    await rm(dir, { recursive: true, force: true });
    try {
      await rename(next, dir);
    } catch (err) {
      // Another process got there first with a complete copy: keep it.
      if (!existsSync(versionFile)) throw err;
    }
    opts.log?.(`sandbox: copied graph-execution ${version} to ${dir}`);
  } finally {
    await rm(next, { recursive: true, force: true });
  }
  return dir;
}
