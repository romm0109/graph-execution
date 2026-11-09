// The sandbox tools folder (KAN-88): the engine with its production dependencies, which every sandbox container mounts
// read-only at /opt/gm-tools. The provider CLIs come from the `gm-clis` volume instead (sandbox-image.ts): they are
// installed inside Docker, so they are Linux builds even when graph-manager runs on macOS. POSIX only.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { renameReplacing } from "graph-execution/api";
import { chmod, cp, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where a sandbox container sees the tools folder. */
export const TOOLS_TARGET = "/opt/gm-tools";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
}

/** The VERSION of a tools folder: graph-manager's version, the engine's version, and the mtime of its cli.js (a rebuilt engine refreshes it). */
export function toolsVersion(gmVersion: string, engineDir: string): string {
  const engine = readPackageJson(engineDir).version ?? "?";
  const mtime = statSync(path.join(engineDir, "dist", "cli.js")).mtimeMs;
  return `${gmVersion} ${engine} ${mtime}`;
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

/** Copies with symlinks resolved (workspace and global installs are symlinks); skips `node_modules/.bin` (links to copied files). */
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
 * `copiedRoots` (trees already copied along with their nested node_modules) are not placed again, only traversed.
 */
async function copyDependencies(pkgDir: string, destModules: string, copiedRoots: string[]): Promise<void> {
  const roots = [...copiedRoots];
  const placed = new Set<string>();
  const visited = new Set<string>();
  const start = await realpath(pkgDir);
  const queue: { name: string; optional: boolean; fromDir: string }[] = depsOf(readPackageJson(start)).map((d) => ({ ...d, fromDir: start }));
  for (let item = queue.shift(); item; item = queue.shift()) {
    const found = resolvePackage(item.name, item.fromDir);
    if (!found) {
      if (item.optional) continue;
      throw new Error(`cannot find ${item.name} for the sandbox tools`);
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

/** Copies the engine package (package.json, dist/, skills/, README.md) and its production dependencies into `dest`. */
export async function copyEngine(engineDir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of ["package.json", "dist", "skills", "README.md"]) {
    const src = path.join(engineDir, entry);
    if (existsSync(src)) await copyTree(src, path.join(dest, entry));
    else if (entry === "package.json" || entry === "dist") throw new Error(`${src} is missing`);
  }
  await copyDependencies(engineDir, path.join(dest, "node_modules"), []);
}

async function writeWrapper(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\nd=$(dirname "$0")\n${body}\n`, { mode: 0o755 });
  await chmod(file, 0o755);
}

/**
 * Fills the tools folder `dir` unless its VERSION is current. The new content is built aside and swapped in; VERSION is
 * written last. A `lib` folder (provider CLIs copied by older versions) is removed in any case.
 */
export async function fillTools(
  dir: string,
  opts: { engineDir: string; gmVersion: string; log?: (l: string) => void },
): Promise<"fresh" | "filled"> {
  await mkdir(dir, { recursive: true });
  await rm(path.join(dir, "lib"), { recursive: true, force: true });
  const version = toolsVersion(opts.gmVersion, opts.engineDir);
  const versionFile = path.join(dir, "VERSION");
  try {
    if (readFileSync(versionFile, "utf8") === version) return "fresh";
  } catch {
    // no VERSION: fill
  }
  const next = path.join(dir, `.next-${randomBytes(4).toString("hex")}`);
  try {
    await copyEngine(opts.engineDir, path.join(next, "graph-execution"));
    await writeWrapper(path.join(next, "bin", "graph-execution"), `exec node "$d/../graph-execution/dist/cli.js" "$@"`);
    await rm(versionFile, { force: true });
    for (const entry of ["graph-execution", "bin"]) {
      await rm(path.join(dir, entry), { recursive: true, force: true });
      await rename(path.join(next, entry), path.join(dir, entry));
    }
    opts.log?.("sandbox tools: copied graph-execution");
  } finally {
    for (const entry of await readdir(dir)) {
      if (entry.startsWith(".next-")) await rm(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  const tmp = `${versionFile}.tmp`;
  await writeFile(tmp, version);
  await renameReplacing(tmp, versionFile);
  return "filled";
}
