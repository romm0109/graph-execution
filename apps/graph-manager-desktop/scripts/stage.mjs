// Stages the desktop app for electron-builder in apps/graph-manager-desktop/stage/: the built dist/, a package.json
// whose graph-execution and graph-manager dependencies are `npm pack` tarballs of the workspace packages, their
// production node_modules, the electron-builder config (with electronVersion from the desktop package.json) and the
// afterPack hook. Plain Node, cross-platform: no shell syntax.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(desktopDir, "..", "..");
const stageDir = path.join(desktopDir, "stage");
const isWin = process.platform === "win32";

/** Runs npm with `args` in `cwd`; npm is npm.cmd on Windows, which needs a shell. */
function npm(args, cwd, opts = {}) {
  return execFileSync(isWin ? "npm.cmd" : "npm", args, {
    cwd,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    shell: isWin,
    env: opts.env ?? process.env,
  });
}

const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const electronVersion = desktopPkg.devDependencies?.electron;
if (!electronVersion || !/^\d+\.\d+\.\d+/.test(electronVersion)) {
  throw new Error(`apps/graph-manager-desktop/package.json must pin electron to an exact version (got ${electronVersion})`);
}

// 1. Build the three packages.
for (const ws of ["graph-execution", "graph-manager", "graph-manager-desktop"]) {
  npm(["run", "build", "-w", ws], repoRoot);
}

// 2. Pack graph-execution and graph-manager.
const packDir = mkdtempSync(path.join(os.tmpdir(), "gm-desktop-pack-"));
npm(["pack", "-w", "graph-execution", "-w", "graph-manager", "--pack-destination", packDir], repoRoot, { capture: true });
const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
const tarballOf = (name) => {
  const f = tarballs.find((t) => t.startsWith(`${name}-`) && /^\d/.test(t.slice(name.length + 1)));
  if (!f) throw new Error(`npm pack made no tarball for ${name} in ${packDir} (found: ${tarballs.join(", ") || "none"})`);
  return f;
};

// 3. Recreate stage/ with the desktop dist/.
rmSync(stageDir, { recursive: true, force: true, maxRetries: 5 });
mkdirSync(path.join(stageDir, "vendor"), { recursive: true });
cpSync(path.join(desktopDir, "dist"), path.join(stageDir, "dist"), { recursive: true });
const deps = {};
for (const name of ["graph-execution", "graph-manager"]) {
  const file = tarballOf(name);
  cpSync(path.join(packDir, file), path.join(stageDir, "vendor", file));
  deps[name] = `file:vendor/${file}`;
}
rmSync(packDir, { recursive: true, force: true, maxRetries: 5 });
deps.zod = desktopPkg.dependencies.zod;

// 4. stage/package.json.
const stagePkg = {
  name: desktopPkg.name,
  version: desktopPkg.version,
  description: desktopPkg.description,
  author: "romm0109",
  type: "module",
  main: "dist/main.js",
  dependencies: deps,
};
writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(stagePkg, null, 2)}\n`);

// 5. Production install; the tarballs aren't needed afterwards. NODE_ENV is left out: --omit=dev says it already.
const env = { ...process.env };
delete env.NODE_ENV;
npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], stageDir, { env });
rmSync(path.join(stageDir, "vendor"), { recursive: true, force: true, maxRetries: 5 });

// 6. The electron-builder config and the afterPack hook, next to the staged app: electron-builder runs in stage/.
const config = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8").replace(
  /^electronVersion:.*$/m,
  `electronVersion: ${electronVersion}`,
);
if (!config.includes(`electronVersion: ${electronVersion}`)) throw new Error("electron-builder.yml has no electronVersion line");
writeFileSync(path.join(stageDir, "electron-builder.yml"), config);
cpSync(path.join(desktopDir, "scripts", "after-pack.cjs"), path.join(stageDir, "after-pack.cjs"));

console.log(`staged: ${stageDir}`);
