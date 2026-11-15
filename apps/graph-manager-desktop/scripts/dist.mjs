// Stages the app (scripts/stage.mjs) and packages it with electron-builder for this OS: a dmg on macOS, an NSIS
// installer on Windows. Extra arguments go to electron-builder (e.g. `npm run dist -- --linux dir` to try the layout).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stageDir = path.join(desktopDir, "stage");

// `npm run dist` stages first (`npm run stage`) and passes --skip-stage; run directly, this script stages itself.
const argv = process.argv.slice(2);
if (!argv.includes("--skip-stage")) {
  execFileSync(process.execPath, [path.join(desktopDir, "scripts", "stage.mjs")], { stdio: "inherit" });
}

const extra = argv.filter((a) => a !== "--skip-stage");
const platformFlag = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform];
const targets = extra.some((a) => ["--mac", "--win", "--linux", "-m", "-w", "-l"].includes(a)) ? [] : [platformFlag];
const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
// Runs in stage/, so the config's relative paths (output, afterPack) are relative to stage/.
execFileSync(process.execPath, [cli, "--config", "electron-builder.yml", "--projectDir", ".", "--publish", "never", ...targets, ...extra], {
  cwd: stageDir,
  stdio: "inherit",
  env: { CSC_IDENTITY_AUTO_DISCOVERY: "false", ...process.env },
});
