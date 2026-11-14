// electron-builder afterPack hook: on macOS, makes node-pty's spawn-helper executable inside the packaged app, as
// graph-manager's postinstall does for a normal install. Without it, every terminal fails with "posix_spawnp failed".
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productName = context.packager.appInfo.productFilename;
  const prebuilds = path.join(
    context.appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  if (!fs.existsSync(prebuilds)) throw new Error(`afterPack: ${prebuilds} is missing`);
  for (const arch of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, arch, "spawn-helper");
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`afterPack: chmod 755 ${helper}`);
    }
  }
};
