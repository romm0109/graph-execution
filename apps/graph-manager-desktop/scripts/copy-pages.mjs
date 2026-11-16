// Copies src/pages/*.html to dist/pages/, which tsc doesn't do. Cross-platform: no shell cp.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, "src", "pages");
const to = path.join(root, "dist", "pages");
mkdirSync(to, { recursive: true });
if (existsSync(from)) {
  for (const name of readdirSync(from)) {
    if (name.endsWith(".html")) cpSync(path.join(from, name), path.join(to, name));
  }
}
