import { existsSync } from "node:fs";
import path from "node:path";
import { findOnPath } from "../providers/index.js";

/** Picks the shell for setup/validate commands on Windows: `cmd` keeps `cmd.exe`, a path names a POSIX `sh`. */
export const SHELL_ENV = "GRAPH_EXECUTION_SHELL";

/**
 * The POSIX shell that runs setup and validate commands, or undefined for the platform's default shell (`/bin/sh` on
 * POSIX, `cmd.exe` on Windows). Commands are written for `sh` (`export`, `rm -rf`, `$VAR`, `a && b`), and on Windows
 * `cmd.exe` would get them verbatim and fail (GE-17). git is required anyway, and Git for Windows ships `sh.exe`, so
 * on Windows this is, in order: `GRAPH_EXECUTION_SHELL` (`cmd` for `cmd.exe`), `sh` on the PATH, the `sh.exe` of the
 * Git for Windows install that `git` on the PATH belongs to; otherwise `cmd.exe`.
 */
export function posixShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: (bin: string) => string | undefined = (bin) => findOnPath(bin, process.cwd(), env, platform),
  exists: (file: string) => boolean = existsSync,
): string | undefined {
  if (platform !== "win32") return undefined;
  const chosen = env[SHELL_ENV]?.trim();
  if (chosen) return chosen.toLowerCase() === "cmd" || chosen.toLowerCase() === "cmd.exe" ? undefined : chosen;
  const sh = find("sh");
  if (sh) return sh;
  const git = find("git");
  if (!git) return undefined;
  // git.exe sits in <root>\cmd, <root>\bin or <root>\mingw64\bin; sh.exe in <root>\bin or <root>\usr\bin.
  const w = path.win32;
  let dir = w.dirname(git);
  if (w.basename(dir).toLowerCase() === "bin" && w.basename(w.dirname(dir)).toLowerCase() === "mingw64") dir = w.dirname(dir);
  const root = w.dirname(dir);
  return [w.join(root, "bin", "sh.exe"), w.join(root, "usr", "bin", "sh.exe")].find(exists);
}
