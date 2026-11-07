import { statSync } from "node:fs";
import path from "node:path";
import { CLAUDE_BIN, claudeArgs, claudeProvider } from "./claude.js";
import { CODEX_BIN, codexArgs, codexProvider } from "./codex.js";
import { OPENCODE_BIN, opencodeArgs, opencodeProvider } from "./opencode.js";
import { QWEN_BIN, qwenArgs, qwenProvider } from "./qwen.js";
import { createFakeProvider, loadFakeScript } from "./fake.js";
import type { Provider } from "./types.js";

/**
 * Where `bin` resolves on the PATH, or undefined. Done in-process rather than with `which`, which Windows lacks.
 * On Windows it resolves the way the spawn does (cross-spawn, inside execa): a name without a PATHEXT extension gets
 * each PATHEXT extension in turn and is never taken bare. npm installs a CLI there as an extensionless `sh` shim next
 * to `claude.cmd`; Windows cannot run the bare one, so finding it would pass the startup check for a CLI that the
 * spawn then resolves differently, or not at all. A name that already ends in a PATHEXT extension is taken as is.
 */
export function findOnPath(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  stat: (file: string) => { isFile(): boolean; mode: number } = statSync,
): string | undefined {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  // Windows env names are case-insensitive, and `Path` is the usual spelling there.
  const get = (name: string): string | undefined =>
    win ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name];
  let exts = [""];
  if (win) {
    const pathExt = (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const own = p.extname(bin).toUpperCase();
    exts = own !== "" && pathExt.some((e) => e.toUpperCase() === own) ? [""] : pathExt;
  }
  for (const dir of (get("PATH") ?? "").split(p.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = p.resolve(cwd, dir, bin + ext);
      try {
        const st = stat(candidate);
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
      claudeArgs({}); // A malformed GRAPH_EXECUTION_CLAUDE_ARGS value throws here, at startup.
      return claudeProvider;
    case "codex":
      await requireOnPath(CODEX_BIN, cwd);
      codexArgs({}); // A malformed GRAPH_EXECUTION_CODEX_ARGS value throws here, at startup.
      return codexProvider;
    case "opencode":
      await requireOnPath(OPENCODE_BIN, cwd);
      opencodeArgs({}); // A malformed GRAPH_EXECUTION_OPENCODE_ARGS value throws here, at startup.
      return opencodeProvider;
    case "qwen":
      await requireOnPath(QWEN_BIN, cwd);
      qwenArgs({}); // A malformed GRAPH_EXECUTION_QWEN_ARGS value throws here, at startup.
      return qwenProvider;
    case "fake":
      return createFakeProvider(await loadFakeScript());
    default:
      throw new Error(`provider "${name}" is not implemented yet`);
  }
}
