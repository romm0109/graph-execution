// Copies the built graph-manager (apps/graph-manager/dist/{server,web}) into dist/manager, so the npm package ships
// it; run by the root `npm run build`. Usage: node scripts/bundle-manager.mjs [sourceDist] [destDir]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(engineDir, "..", "..");
const [sourceArg, destArg] = process.argv.slice(2);
const source = path.resolve(sourceArg ?? path.join(repoDir, "apps", "graph-manager", "dist"));
const dest = path.resolve(destArg ?? path.join(engineDir, "dist", "manager"));
const { version } = JSON.parse(readFileSync(path.join(engineDir, "package.json"), "utf8"));

if (!existsSync(path.join(source, "server", "main.js")) || !existsSync(path.join(source, "web", "index.html"))) {
  console.error("apps/graph-manager/dist is missing: build graph-manager first");
  process.exit(1);
}

// Only these three entries: the engine's own compiled files (src/manager/*.ts) live in the same folder.
for (const entry of ["server", "web", "package.json"]) rmSync(path.join(dest, entry), { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const filter = (f) => !path.basename(f).includes(".test.");
for (const entry of ["server", "web"]) cpSync(path.join(source, entry), path.join(dest, entry), { recursive: true, filter });
// A package scope of its own: the server files are ES modules, and this is where the manager reads its version.
writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: "graph-manager", version, type: "module", private: true }, null, 2) + "\n");
console.log(`Bundled graph-manager into ${dest}`);
