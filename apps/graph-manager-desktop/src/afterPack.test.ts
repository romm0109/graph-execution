// The macOS afterPack hook can't run against a real .dmg build here, so this runs it against a fake macOS app layout:
// spawn-helper must come out executable, node-pty's helper path must be patched, other platforms are left alone, and a
// missing prebuilds folder or an unknown node-pty fails the build.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// The two lines of node-pty 1.1's lib/unixTerminal.js that the hook patches.
const UNIX_TERMINAL = [
  "var helperPath = native.dir + '/spawn-helper';",
  "helperPath = path.resolve(__dirname, helperPath);",
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
  "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  "exports.helperPath = helperPath;",
  "",
].join("\n");

/** Runs the helper-path lines of a (patched) unixTerminal.js for a module dir and returns the spawn-helper path. */
function helperPathFor(src: string, dirname: string): string {
  const native = { dir: "../prebuilds/darwin-arm64" };
  const exports: { helperPath?: string } = {};
  new Function("native", "path", "__dirname", "exports", src)(native, path.posix, dirname, exports);
  return exports.helperPath!;
}

function fakeApp(withPrebuilds = true, unixTerminal = UNIX_TERMINAL) {
  const out = mkdtempSync(path.join(tmpdir(), "gm-afterpack-"));
  dirs.push(out);
  const prebuilds = path.join(out, "graph-manager.app", "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");
  const helpers: string[] = [];
  const lib = path.join(prebuilds, "..", "lib");
  mkdirSync(lib, { recursive: true });
  const unixTerminalFile = path.join(lib, "unixTerminal.js");
  writeFileSync(unixTerminalFile, unixTerminal);
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
  return { ctx, helpers, unixTerminalFile };
}

describe.skipIf(process.platform === "win32")("after-pack hook", () => {
  it("makes node-pty's spawn-helper executable in a macOS build", async () => {
    const { ctx, helpers } = fakeApp();
    await afterPack(ctx("darwin"));
    for (const h of helpers) expect(statSync(h).mode & 0o777).toBe(0o755);
  });

  it("patches node-pty so spawn-helper is found in app.asar.unpacked, not app.asar.unpacked.unpacked", async () => {
    const lib = "/Applications/graph-manager.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/lib";
    // The bug the hook fixes: node-pty 1.1 as published doubles the suffix.
    expect(helperPathFor(UNIX_TERMINAL, lib)).toContain("app.asar.unpacked.unpacked");

    const { ctx, unixTerminalFile } = fakeApp();
    await afterPack(ctx("darwin"));
    const patched = readFileSync(unixTerminalFile, "utf8");
    expect(helperPathFor(patched, lib)).toBe(
      "/Applications/graph-manager.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    );
    // A node-pty loaded through app.asar still gets the unpacked path, and a second run changes nothing.
    expect(helperPathFor(patched, lib.replace("app.asar.unpacked", "app.asar"))).toContain("/app.asar.unpacked/node_modules/");
    await afterPack(ctx("darwin"));
    expect(readFileSync(unixTerminalFile, "utf8")).toBe(patched);
  });

  it("fails a macOS build when node-pty no longer has the line it patches", async () => {
    const { ctx } = fakeApp(true, "exports.helperPath = 'somewhere else';\n");
    await expect(afterPack(ctx("darwin"))).rejects.toThrow(/no longer contains/);
  });

  it("leaves Windows and Linux builds alone", async () => {
    const { ctx, helpers, unixTerminalFile } = fakeApp();
    await afterPack(ctx("win32"));
    await afterPack(ctx("linux"));
    for (const h of helpers) expect(statSync(h).mode & 0o777).toBe(0o644);
    expect(readFileSync(unixTerminalFile, "utf8")).toBe(UNIX_TERMINAL);
  });

  it("fails a macOS build whose node-pty prebuilds are missing", async () => {
    const { ctx } = fakeApp(false);
    await expect(afterPack(ctx("darwin"))).rejects.toThrow(/is missing/);
  });
});
