import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledPaths {
  serverEntry: string;
  graphExecutionCli: string;
}

/**
 * graph-manager's `dist/server/main.js` and graph-execution's `dist/cli.js`: under `resources/app.asar.unpacked/node_modules`
 * when packaged, else resolved from the workspace packages.
 */
export function bundledPaths(opts: {
  packaged: boolean;
  resourcesPath?: string;
  resolvePackageJson?: (name: string) => string;
}): BundledPaths {
  if (opts.packaged) {
    if (!opts.resourcesPath) throw new Error("resourcesPath is required when packaged");
    const modules = path.join(opts.resourcesPath, "app.asar.unpacked", "node_modules");
    return {
      serverEntry: path.join(modules, "graph-manager", "dist", "server", "main.js"),
      graphExecutionCli: path.join(modules, "graph-execution", "dist", "cli.js"),
    };
  }
  const resolve = opts.resolvePackageJson ?? resolvePackageJson;
  return {
    serverEntry: path.join(path.dirname(resolve("graph-manager")), "dist", "server", "main.js"),
    graphExecutionCli: path.join(path.dirname(resolve("graph-execution")), "dist", "cli.js"),
  };
}

/** The real path of `<name>/package.json`, as graph-manager's `resolveGraphExecutionPackage()` finds it. */
export function resolvePackageJson(name: string): string {
  try {
    return realpathSync(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
  } catch {
    // import.meta.resolve is missing under some loaders (vitest), and an `exports` map may hide package.json:
    // look in the node_modules dirs Node would search instead.
  }
  try {
    const require = createRequire(import.meta.url);
    for (const dir of require.resolve.paths(name) ?? []) {
      const file = path.join(dir, name, "package.json");
      if (existsSync(file)) return realpathSync(file);
    }
  } catch {
    // fall through
  }
  throw new Error(`can't find ${name}; run npm install at the repo root`);
}
