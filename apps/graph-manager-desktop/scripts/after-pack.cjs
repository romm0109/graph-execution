// electron-builder afterPack hook, macOS only. Without either fix every terminal fails with "posix_spawnp failed":
// - makes node-pty's spawn-helper executable inside the packaged app, as graph-manager's postinstall does for a normal
//   install;
// - patches node-pty's helper path. node-pty 1.1 does `helperPath.replace('app.asar', 'app.asar.unpacked')`, but the
//   server loads node-pty from app.asar.unpacked already, so the path became app.asar.unpacked.unpacked/... .
const fs = require("node:fs");
const path = require("node:path");

const HELPER_PATH_FIXES = [
  ["helperPath.replace('app.asar', 'app.asar.unpacked')", "helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')"],
  [
    "helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked')",
    "helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked')",
  ],
];

/** Rewrites node-pty's asar replace so it leaves a path already in app.asar.unpacked alone. Idempotent. */
function patchHelperPath(nodePtyDir) {
  const file = path.join(nodePtyDir, "lib", "unixTerminal.js");
  if (!fs.existsSync(file)) throw new Error(`afterPack: ${file} is missing`);
  let src = fs.readFileSync(file, "utf8");
  for (const [from, to] of HELPER_PATH_FIXES) {
    if (src.includes(from)) src = src.replace(from, to);
    else if (!src.includes(to)) {
      throw new Error(`afterPack: ${file} no longer contains ${from}; check how node-pty finds spawn-helper`);
    }
  }
  fs.writeFileSync(file, src);
  console.log(`afterPack: patched the spawn-helper path in ${file}`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productName = context.packager.appInfo.productFilename;
  const nodePty = path.join(
    context.appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  const prebuilds = path.join(nodePty, "prebuilds");
  if (!fs.existsSync(prebuilds)) throw new Error(`afterPack: ${prebuilds} is missing`);
  for (const arch of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, arch, "spawn-helper");
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`afterPack: chmod 755 ${helper}`);
    }
  }
  patchHelperPath(nodePty);
};

exports.HELPER_PATH_FIXES = HELPER_PATH_FIXES;
