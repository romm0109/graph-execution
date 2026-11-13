// The graph-manager bundle (scripts/bundle-manager.mjs → dist/manager). The global setup bundles once before the
// suite; no test here writes to dist/manager, because other tests start the bundled manager in parallel.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(pkgRoot, "scripts", "bundle-manager.mjs");
const BUNDLE = path.join(pkgRoot, "dist", "manager");
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as { version: string };

function write(file: string, content = ""): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe("scripts/bundle-manager.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ge-bundle-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits 1 when graph-manager is not built", async () => {
    const dest = path.join(dir, "dest");
    const res = await execa("node", [SCRIPT, path.join(dir, "missing"), dest], { reject: false });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("apps/graph-manager/dist is missing: build graph-manager first");
    expect(existsSync(dest)).toBe(false);

    // A server without the web build is not enough.
    write(path.join(dir, "half", "server", "main.js"));
    const half = await execa("node", [SCRIPT, path.join(dir, "half"), dest], { reject: false });
    expect(half.exitCode).toBe(1);
    expect(existsSync(dest)).toBe(false);
  });

  it("copies server and web without test files, and replaces only its own entries", async () => {
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    write(path.join(source, "server", "main.js"), "main");
    write(path.join(source, "server", "a.test.js"), "test");
    write(path.join(source, "server", "routes", "r.js"), "r");
    write(path.join(source, "web", "index.html"), "<html>");
    write(path.join(dest, "server", "old.js"), "old");
    write(path.join(dest, "keep.js"), "keep");
    write(path.join(dest, "package.json"), "{}");

    const res = await execa("node", [SCRIPT, source, dest], { cwd: dir });
    expect(res.stdout.trim()).toBe(`Bundled graph-manager into ${dest}`);
    expect(readFileSync(path.join(dest, "server", "main.js"), "utf8")).toBe("main");
    expect(readFileSync(path.join(dest, "server", "routes", "r.js"), "utf8")).toBe("r");
    expect(readFileSync(path.join(dest, "web", "index.html"), "utf8")).toBe("<html>");
    expect(existsSync(path.join(dest, "server", "a.test.js"))).toBe(false);
    expect(existsSync(path.join(dest, "server", "old.js"))).toBe(false);
    expect(readFileSync(path.join(dest, "keep.js"), "utf8")).toBe("keep");
    expect(JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8"))).toEqual({ name: "graph-manager", version, type: "module", private: true });
  });
});

describe.skipIf(!existsSync(path.join(BUNDLE, "server", "main.js")))("the bundled manager (needs npm run build at the root)", () => {
  it("is in the npm tarball, without test files", async () => {
    const res = await execa("npm", ["pack", "--dry-run", "--json"], { cwd: pkgRoot });
    const packed = JSON.parse(res.stdout) as { files: { path: string }[] }[];
    const paths = (packed[0]?.files ?? []).map((f) => f.path);
    for (const expected of ["dist/manager/server/main.js", "dist/manager/web/index.html", "dist/manager/web/favicon.svg", "dist/manager/package.json", "dist/cli.js"]) {
      expect(paths).toContain(expected);
    }
    expect(paths.filter((p) => p.endsWith(".test.js"))).toEqual([]);
  }, 60_000);

  it("finds its version and the engine from dist/manager/server", async () => {
    const href = (file: string): string => pathToFileURL(path.join(BUNDLE, "server", file)).href;
    const code = [
      `const { gmVersion } = await import(${JSON.stringify(href("version.js"))});`,
      `const { defaultGraphExecutionBin } = await import(${JSON.stringify(href("config.js"))});`,
      "console.log(JSON.stringify({ version: gmVersion(), bin: defaultGraphExecutionBin() }));",
    ].join("\n");
    // A cwd outside the repository: nothing may depend on where the manager is started.
    const res = await execa("node", ["--input-type=module", "-e", code], { cwd: os.tmpdir() });
    const out = JSON.parse(res.stdout) as { version: string; bin: string };
    expect(out.version).toBe(version);
    expect(realpathSync(out.bin)).toBe(realpathSync(path.join(pkgRoot, "dist", "cli.js")));
  }, 60_000);
});
