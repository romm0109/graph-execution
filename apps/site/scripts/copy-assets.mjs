// Copies the demo video and its poster from docs/assets into public/,
// so the repo keeps one copy of each. Paths come from this file, not the cwd.
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assets = new URL("../../../docs/assets/", import.meta.url);
const pub = new URL("../public/", import.meta.url);

mkdirSync(fileURLToPath(pub), { recursive: true });
for (const name of ["demo.mp4", "demo-poster.jpg"]) {
  copyFileSync(fileURLToPath(new URL(name, assets)), fileURLToPath(new URL(name, pub)));
}
