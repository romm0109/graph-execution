import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      ".graph-execution/",
      "ralph-logs/",
      ".agents/",
      "packages/graph-execution/src/web/assets/vendor/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Browser modules run in the page, where DOM globals exist.
  { files: ["packages/graph-execution/src/web/assets/**/*.js"], rules: { "no-undef": "off" } },
  // The standalone skill scripts run on plain Node.
  // graph-manager's React UI runs in the browser.
  {
    files: ["apps/graph-manager/src/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        location: "readonly",
        localStorage: "readonly",
        WebSocket: "readonly",
        EventSource: "readonly",
      },
    },
  },
  { files: ["packages/*/skills/**/*.mjs", "packages/*/scripts/**/*.mjs", ".claude/skills/**/*.mjs", "apps/*/scripts/**/*.mjs", ".github/scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
);
