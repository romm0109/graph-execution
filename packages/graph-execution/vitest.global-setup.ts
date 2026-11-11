import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

// CLI tests run the built entry (dist/cli.js), so build once before the suite.
export default async function setup(): Promise<void> {
  const cwd = fileURLToPath(new URL(".", import.meta.url));
  await execa("npm", ["run", "build"], { cwd, stdio: "inherit" });
  // The build deleted dist/manager: bundle graph-manager again when it is built. Here, once, and never from a test
  // file: tests run in parallel and some start the bundled manager.
  if (existsSync(fileURLToPath(new URL("../../apps/graph-manager/dist/server/main.js", import.meta.url)))) {
    await execa("node", ["scripts/bundle-manager.mjs"], { cwd, stdio: "inherit" });
  }
}
