// Renders the home-screen icons from src/web/public/favicon.svg with agent-browser (headless Chrome):
// node apps/graph-manager/scripts/make-icons.mjs  (or: npm run icons -w graph-manager)
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const publicDir = path.join(appDir, "src/web/public");
const outDir = path.join(publicDir, "icons");
const BG = "#16181b"; // --sf (dark). Opaque: iOS turns transparent pixels black.

const source = readFileSync(path.join(publicDir, "favicon.svg"), "utf8");
if (!/<style>[\s\S]*?<\/style>/.test(source)) {
  console.error("make-icons: favicon.svg has no <style> block to replace");
  process.exit(1);
}
// The light mark of the dark scheme, fixed (headless Chrome renders the light scheme by default).
const svg = source.replace(/<style>[\s\S]*?<\/style>/, "<style>.bg{fill:#ecedef}.dot{fill:#16181b}.edge{stroke:#16181b}</style>");
const b64 = Buffer.from(svg, "utf8").toString("base64");

/** The mark's rounded square (x/y 1–21 of the 22 viewBox) fills the canvas, or the whole mark at 80 % for maskable. */
const ICONS = [
  { file: "apple-touch-icon.png", size: 180, maskable: false },
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];

const SESSION = `gm-make-icons-${process.pid}`;
const ab = (...a) => execFileSync("agent-browser", ["--session", SESSION, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

mkdirSync(outDir, { recursive: true });
ab("open", "about:blank");
try {
  for (const { file, size: s, maskable } of ICONS) {
    const [d, w] = maskable ? [s * 0.1, s * 0.8] : [-s / 20, s * 1.1];
    const out = ab(
      "eval",
      `(async()=>{const img=new Image();img.src="data:image/svg+xml;base64,${b64}";await img.decode();` +
        `const c=document.createElement("canvas");c.width=c.height=${s};const x=c.getContext("2d");` +
        `x.fillStyle="${BG}";x.fillRect(0,0,${s},${s});x.drawImage(img,${d},${d},${w},${w});return c.toDataURL("image/png");})()`,
    );
    const dataUrl = JSON.parse(out.trim());
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) throw new Error(`make-icons: unexpected eval output for ${file}`);
    const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
    const target = path.join(outDir, file);
    writeFileSync(target, buf);
    console.log(`${path.relative(appDir, target)}  ${s}x${s}  ${buf.length} bytes`);
  }
} finally {
  ab("close");
}
