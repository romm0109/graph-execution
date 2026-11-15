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
      "**/.astro/",
      "packages/graph-execution/src/web/assets/vendor/",
      "apps/graph-manager-desktop/stage/",
      "apps/graph-manager-desktop/release/",
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
  // The desktop app's packaging scripts: plain Node (timers and fetch); the electron-builder hook is CommonJS.
  {
    files: ["apps/graph-manager-desktop/scripts/**/*.{mjs,cjs}"],
    languageOptions: {
      globals: { setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", fetch: "readonly" },
    },
  },
  {
    files: ["apps/graph-manager-desktop/scripts/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "writable", exports: "writable", console: "readonly", process: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // The service worker runs in the worker scope.
  { files: ["apps/graph-manager/src/web/public/**/*.js"], languageOptions: { globals: { self: "readonly", fetch: "readonly", Response: "readonly" } } },
  { files: ["packages/*/skills/**/*.mjs", "packages/*/scripts/**/*.mjs", ".claude/skills/**/*.mjs", "apps/*/scripts/**/*.mjs", "apps/*/astro.config.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } } },
);
