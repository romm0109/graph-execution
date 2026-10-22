import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", ".graph-execution/", "ralph-logs/", ".agents/", "src/web/assets/vendor/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Browser modules run in the page, where DOM globals exist.
  { files: ["src/web/assets/**/*.js"], rules: { "no-undef": "off" } },
  // The standalone skill scripts run on plain Node.
  { files: ["skills/**/*.mjs", ".claude/skills/**/*.mjs", "scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
);
