import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");

describe("CI workflows", () => {
  it("runs the release gate on push and pull_request", () => {
    const qa = readFileSync(path.join(workflowsDir, "qa.yml"), "utf8");
    for (const needle of ["push", "pull_request", "npm ci", "npm run typecheck", "npm run lint", "npm test"]) {
      expect(qa).toContain(needle);
    }
  });

  it("only references scripts that exist in the repo", () => {
    const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const file of files) {
      const content = readFileSync(path.join(workflowsDir, file), "utf8");
      for (const match of content.matchAll(/(?:^|\s)((?:\.\/)?scripts\/[\w./-]+)/gm)) {
        const ref = match[1];
        if (ref === undefined) continue;
        if (!existsSync(path.join(repoRoot, ref)) && !existsSync(path.join(pkgRoot, ref))) missing.push(`${file}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
