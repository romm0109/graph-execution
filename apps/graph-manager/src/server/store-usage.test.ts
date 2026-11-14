// Routes and their helpers read state only through the caller's UserStore (`await ctx.store.forUser(req.user)`).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = ["auth.ts", "proxy.ts", "pr.ts", "project-pr.ts", "forges.ts", "liverun.ts", "runhome.ts"];
const FORBIDDEN = [/\b(DataStore|JsonFileStore)\b/, /ctx\.store\.(get|update|reviewers|projects?)\b/];

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(file);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [file] : [];
  });
}

describe("store usage", () => {
  it("routes and helpers go through ctx.store.forUser", () => {
    const files = [...routeFiles(path.join(SERVER_DIR, "routes")), ...HELPERS.map((f) => path.join(SERVER_DIR, f))];
    expect(files.length).toBeGreaterThan(HELPERS.length + 5);
    const failing = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return FORBIDDEN.some((re) => re.test(source));
    });
    expect(failing.map((f) => path.relative(SERVER_DIR, f))).toEqual([]);
  });
});
