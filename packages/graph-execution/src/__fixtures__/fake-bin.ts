import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a fake CLI (a node script with a `#!/usr/bin/env node` line) at `file`. On Windows it also writes the
 * `<name>.cmd` shim next to it, the way npm installs a CLI there: an extensionless file is not found on the PATH.
 */
export async function writeFakeBin(file: string, script: string): Promise<void> {
  await writeFile(file, script);
  await chmod(file, 0o755);
  if (process.platform === "win32") await writeFile(`${file}.cmd`, `@node "%~dp0${path.basename(file)}" %*\r\n`);
}
