import { execFileSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { RUN_ENV_UNSET } from "./src/state/paths.js";

// Run as an agent's command inside a graph-execution run, the tests would inherit that run's folder and id and act
// on the live run. The workers take their environment from this process.
for (const name of Object.keys(RUN_ENV_UNSET)) delete process.env[name];

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
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
