import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// docs/prd/done, resolved from this file so the build works from any cwd.
const specsDir = fileURLToPath(new URL("../../docs/prd/done/", import.meta.url));

export default defineConfig({
  site: "https://graph-execution.com",
  output: "static",
  vite: { define: { __SPECS_DIR__: JSON.stringify(specsDir) } },
});
