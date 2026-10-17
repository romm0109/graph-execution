import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globalSetup: ["./vitest.global-setup.ts"],
    // Most tests run real git repositories, worktrees and agent processes: a few seconds each on a quiet machine,
    // much more on a busy one. The default 5 s limit failed them under load without anything being wrong.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
