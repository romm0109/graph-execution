import { fileURLToPath } from "node:url";
import { execa } from "execa";

// CLI tests run the built entry (dist/cli.js), so build once before the suite.
export default async function setup(): Promise<void> {
  await execa("npm", ["run", "build"], { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit" });
}
