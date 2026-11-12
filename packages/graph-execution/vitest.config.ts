import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { RUN_ENV_UNSET } from "./src/state/paths.js";

// Run as an agent's command inside a graph-execution run, the tests would inherit that run's folder and id and act
// on the live run. The workers take their environment from this process.
for (const name of Object.keys(RUN_ENV_UNSET)) delete process.env[name];
// Run in a graph-manager terminal, the built CLI under test would hand its arguments to graph-manager's engine
// (src/launch/delegate.ts) instead of running itself.
for (const name of ["GRAPH_EXECUTION_DELEGATE", "GRAPH_EXECUTION_DELEGATED", "GM_ENGINE_BIN"]) delete process.env[name];

// On Windows: git usually turns LF into CRLF on checkout (`core.autocrlf=true` on the GitHub runners and in Git for
// Windows' installer default), and the tests compare file contents byte for byte; and os.tmpdir() can be an 8.3 short
// path (C:\Users\RUNNER~1\...) while git and realpath print the long one. The workers take their environment from
// this process.
if (process.platform === "win32") {
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
  process.env.GIT_CONFIG_VALUE_0 = "false";
  try {
    process.env.TEMP = process.env.TMP = realpathSync.native(tmpdir());
  } catch {
    // Keep the short path.
  }
}

// On macOS /usr/bin/git is an xcrun shim that costs ~5 ms per call before git even starts. The tests run
// thousands of git commands, so they put the real binary's folder first on PATH.
function realGitPath(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const git = execFileSync("xcrun", ["-f", "git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `${path.dirname(git)}${path.delimiter}${process.env.PATH ?? ""}`;
  } catch {
    return undefined;
  }
}
const PATH = realGitPath();

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globalSetup: ["./vitest.global-setup.ts"],
    ...(PATH ? { env: { PATH } } : {}),
    // Most tests run real git repositories, worktrees and agent processes: a few seconds each on a quiet machine,
    // much more on a busy one. The default 5 s limit failed them under load without anything being wrong.
    // git and process start-up are several times slower on Windows.
    testTimeout: process.platform === "win32" ? 120_000 : 30_000,
    hookTimeout: process.platform === "win32" ? 120_000 : 30_000,
  },
});
