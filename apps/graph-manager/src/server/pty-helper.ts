// node-pty's macOS prebuilds ship `spawn-helper` without the execute bit on some installs. apps/graph-manager fixes it
// in its postinstall; the published graph-execution package has no postinstall, so the server also fixes it at startup.
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The installed node-pty package folder, when it can be found. */
export function nodePtyDir(): string | undefined {
  try {
    return path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  } catch {
    return undefined;
  }
}

/**
 * Makes node-pty's macOS `spawn-helper` files executable; returns the paths it changed. Never throws. `ptyDir` is the
 * installed node-pty when the argument is left out; an explicit `undefined` means "not found" (a rest parameter,
 * because a default value would replace it).
 */
export function fixSpawnHelper(platform: NodeJS.Platform = process.platform, ...rest: [ptyDir?: string | undefined]): string[] {
  if (platform !== "darwin") return [];
  const ptyDir = rest.length > 0 ? rest[0] : nodePtyDir();
  if (ptyDir === undefined) return [];
  const changed: string[] = [];
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const file = path.join(ptyDir, "prebuilds", arch, "spawn-helper");
    try {
      if (!existsSync(file)) continue;
      chmodSync(file, 0o755);
      changed.push(file);
    } catch {
      // a read-only install: the terminal reports the failure when it is opened
    }
  }
  return changed;
}
