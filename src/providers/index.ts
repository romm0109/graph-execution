import { execa } from "execa";
import { CLAUDE_BIN, claudeProvider } from "./claude.js";
import { CODEX_BIN, codexProvider } from "./codex.js";
import { OPENCODE_BIN, opencodeProvider } from "./opencode.js";
import { createFakeProvider, loadFakeScript } from "./fake.js";
import type { Provider } from "./types.js";

/** Fails fast when a provider's CLI is not on the PATH. */
async function requireOnPath(bin: string, cwd: string): Promise<void> {
  const res = await execa("which", [bin], { cwd, reject: false });
  if (res.exitCode !== 0) {
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
