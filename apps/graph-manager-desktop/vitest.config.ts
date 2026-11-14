import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// On Windows: git usually turns LF into CRLF on checkout (`core.autocrlf=true` on the GitHub runners), and
// os.tmpdir() can be an 8.3 short path (C:\Users\RUNNER~1\...) while realpath prints the long one. The workers take
// their environment from this process.
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

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
  },
});
