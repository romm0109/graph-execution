import { readFileSync } from "node:fs";

/** The version in this package's `package.json`, which sits one folder above both `src/` and `dist/`. */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "unknown";
}
