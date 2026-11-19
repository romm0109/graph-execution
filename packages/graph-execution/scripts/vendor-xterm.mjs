// Copies the browser builds of xterm.js and its addons into dist/web/assets/vendor/xterm/ for the run page's advisor
// terminal (src/web/assets/escalation.js imports them; see src/web/assets/vendor/README.md). Called by the postbuild.
// Every file is a self-contained ES module with no imports, so the page loads them with `import()` from relative URLs.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(engine, "package.json"));
const out = path.join(engine, "dist", "web", "assets", "vendor", "xterm");

/** The installed folder of `pkg`, from its package.json (xterm-zerolag-input does not export it, so walk up from main). */
function pkgDir(pkg) {
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    let dir = path.dirname(require.resolve(pkg));
    while (path.basename(dir) !== pkg.split("/").at(-1)) {
      if (path.dirname(dir) === dir) throw new Error(`vendor-xterm: cannot find the package folder of ${pkg}`);
      dir = path.dirname(dir);
    }
    return dir;
  }
}

const FILES = [
  ["@xterm/xterm", "lib/xterm.mjs", "xterm.mjs"],
  ["@xterm/xterm", "css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit", "lib/addon-fit.mjs", "addon-fit.mjs"],
  ["@xterm/addon-webgl", "lib/addon-webgl.mjs", "addon-webgl.mjs"],
  ["xterm-zerolag-input", "dist/index.js", "xterm-zerolag-input.mjs"],
];

mkdirSync(out, { recursive: true });
for (const [pkg, from, to] of FILES) copyFileSync(path.join(pkgDir(pkg), from), path.join(out, to));
