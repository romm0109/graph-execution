import { statSync } from "node:fs";
import path from "node:path";
import { CLAUDE_BIN, claudeProvider } from "./claude.js";
import { CODEX_BIN, codexProvider } from "./codex.js";
import { OPENCODE_BIN, opencodeProvider } from "./opencode.js";
import { createFakeProvider, loadFakeScript } from "./fake.js";
import type { Provider } from "./types.js";

/**
 * Where `bin` resolves on the PATH, or undefined. Done in-process rather than with `which`, which Windows lacks; on
 * Windows the PATHEXT extensions are tried too, since npm installs CLIs there as `claude.cmd` and the like.
 */
export function findOnPath(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  // Windows env names are case-insensitive, and `Path` is the usual spelling there.
  const get = (name: string): string | undefined =>
    win ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name];
  const exts = win ? ["", ...(get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (get("PATH") ?? "").split(p.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = p.resolve(cwd, dir, bin + ext);
      try {
        const st = statSync(candidate);
        if (st.isFile() && (win || (st.mode & 0o111) !== 0)) return candidate;
      } catch {
        // Not there.
      }
    }
  }
  return undefined;
}

/** Fails fast when a provider's CLI is not on the PATH. */
async function requireOnPath(bin: string, cwd: string): Promise<void> {
  if (findOnPath(bin, cwd) === undefined) {
    throw new Error(`the "${bin}" CLI was not found on the PATH; install it and log in before running`);
  }
}

/** Returns a usable provider or throws (startup check, PRD §7.11). */
export async function getProvider(name: string, cwd = process.cwd()): Promise<Provider> {
  switch (name) {
    case "claude":
      await requireOnPath(CLAUDE_BIN, cwd);
      return claudeProvider;
    case "codex":
      await requireOnPath(CODEX_BIN, cwd);
      return codexProvider;
    case "opencode":
      await requireOnPath(OPENCODE_BIN, cwd);
      return opencodeProvider;
    case "fake":
      return createFakeProvider(await loadFakeScript());
    default:
      throw new Error(`provider "${name}" is not implemented yet`);
  }
}
