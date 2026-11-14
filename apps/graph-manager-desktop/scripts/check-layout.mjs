// Checks the packaged app layout in release/ without running it: the files that bundledPaths() and the forked server
// need are real files under app.asar.unpacked, and on macOS builds node-pty's spawn-helper is executable (afterPack).
// Works on any host, so a macOS layout made on Linux (`npm run dist -- --mac dir`) can be checked there too.
// Usage: node scripts/check-layout.mjs [<release subfolder>...]   (default: every unpacked app found in release/)
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.join(desktopDir, "release");

/** The resources folder of one unpacked app, and whether it is a macOS bundle. */
function resourcesOf(sub) {
  const dir = path.join(releaseDir, sub);
  const app = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".app")) : undefined;
  if (app) return { resources: path.join(dir, app, "Contents", "Resources"), mac: true };
  return { resources: path.join(dir, "resources"), mac: false };
}

const subs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((f) => /^(mac(-arm64|-universal)?|win-unpacked|linux-unpacked)$/.test(f))
    : [];
if (subs.length === 0) {
  console.error(`FAIL: no unpacked app in ${releaseDir}. Run \`npm run dist -w graph-manager-desktop\` first.`);
  process.exit(1);
}

const failures = [];
for (const sub of subs) {
  const { resources, mac } = resourcesOf(sub);
  const modules = path.join(resources, "app.asar.unpacked", "node_modules");
  const need = [
    path.join(resources, "app.asar"),
    path.join(modules, "graph-manager", "dist", "server", "main.js"),
    path.join(modules, "graph-manager", "dist", "web", "index.html"),
    path.join(modules, "graph-execution", "dist", "cli.js"),
    path.join(modules, "node-pty", "package.json"),
  ];
  for (const file of need) {
    if (existsSync(file)) console.log(`ok: ${sub}: ${path.relative(resources, file)}`);
    else failures.push(`${sub}: missing ${path.relative(resources, file)}`);
  }
  if (mac) {
    const prebuilds = path.join(modules, "node-pty", "prebuilds");
    const arches = existsSync(prebuilds) ? readdirSync(prebuilds).filter((a) => a.startsWith("darwin-")) : [];
    if (arches.length === 0) failures.push(`${sub}: no darwin prebuilds in node-pty`);
    for (const arch of arches) {
      for (const f of ["pty.node", "spawn-helper"]) {
        const file = path.join(prebuilds, arch, f);
        if (!existsSync(file)) failures.push(`${sub}: missing node-pty/prebuilds/${arch}/${f}`);
      }
      const helper = path.join(prebuilds, arch, "spawn-helper");
      if (existsSync(helper)) {
        if ((statSync(helper).mode & 0o111) === 0o111) console.log(`ok: ${sub}: ${arch}/spawn-helper is executable`);
        else failures.push(`${sub}: node-pty/prebuilds/${arch}/spawn-helper is not executable`);
      }
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("OK: packaged layout");
