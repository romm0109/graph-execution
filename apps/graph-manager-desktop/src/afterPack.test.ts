// The macOS afterPack hook can't run against a real .dmg build here, so this runs it against a fake macOS app layout:
// spawn-helper must come out executable, other platforms are left alone, and a missing prebuilds folder fails the build.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const afterPack = (createRequire(import.meta.url)("../scripts/after-pack.cjs") as {
  default: (ctx: unknown) => Promise<void>;
}).default;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeApp(withPrebuilds = true) {
  const out = mkdtempSync(path.join(tmpdir(), "gm-afterpack-"));
  dirs.push(out);
  const prebuilds = path.join(out, "graph-manager.app", "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");
  const helpers: string[] = [];
  if (withPrebuilds) {
    for (const arch of ["darwin-arm64", "darwin-x64"]) {
      mkdirSync(path.join(prebuilds, arch), { recursive: true });
      const helper = path.join(prebuilds, arch, "spawn-helper");
      writeFileSync(helper, "#!/bin/sh\n");
      chmodSync(helper, 0o644);
      helpers.push(helper);
    }
  }
  const ctx = (platform: string) => ({
    electronPlatformName: platform,
    appOutDir: out,
    packager: { appInfo: { productFilename: "graph-manager" } },
  });
  return { ctx, helpers };
}

describe.skipIf(process.platform === "win32")("after-pack hook", () => {
  it("makes node-pty's spawn-helper executable in a macOS build", async () => {
    const { ctx, helpers } = fakeApp();
    await afterPack(ctx("darwin"));
    for (const h of helpers) expect(statSync(h).mode & 0o777).toBe(0o755);
  });

  it("leaves Windows and Linux builds alone", async () => {
    const { ctx, helpers } = fakeApp();
    await afterPack(ctx("win32"));
    await afterPack(ctx("linux"));
    for (const h of helpers) expect(statSync(h).mode & 0o777).toBe(0o644);
  });

  it("fails a macOS build whose node-pty prebuilds are missing", async () => {
    const { ctx } = fakeApp(false);
    await expect(afterPack(ctx("darwin"))).rejects.toThrow(/is missing/);
  });
});
