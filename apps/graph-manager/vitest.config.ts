import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 30000,
    // React only ships act() in its development build; a NODE_ENV=production shell would load the other one.
    env: { NODE_ENV: "test" },
  },
});
