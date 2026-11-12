import { readFileSync } from "node:fs";

/** graph-manager's version: dist/manager/package.json when bundled into graph-execution, else apps/graph-manager/package.json. */
export function gmVersion(from: string | URL = import.meta.url): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, from), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "graph-manager" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // not this layout
    }
  }
  throw new Error("cannot find graph-manager's package.json");
}
