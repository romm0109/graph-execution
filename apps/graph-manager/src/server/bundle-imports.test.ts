// graph-manager ships inside the graph-execution npm package (dist/manager), so its server may import only what that
// package installs: the engine's own dependencies.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANAGER_ONLY_DEPENDENCIES } from "./sandbox-tools.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PKG = fileURLToPath(new URL("../../../../packages/graph-execution/package.json", import.meta.url));
const engineDeps = Object.keys((JSON.parse(readFileSync(ENGINE_PKG, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(file);
    // host/contract.ts is the shared test suite of every WorkspaceHost: test code, not built (tsconfig.json excludes it).
    const testOnly = /\.test\.[a-z]+$/.test(e.name) || path.relative(SERVER_DIR, file).split(path.sep).join("/") === "host/contract.ts";
    return /\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !testOnly ? [file] : [];
  });
}

/** The bare specifiers of `from "x"`, `import "x"` and `import("x")`. */
function bareImports(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g)) {
    const spec = m[2];
    if (spec !== undefined && !spec.startsWith(".")) found.push(spec);
  }
  return found;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

describe("the server's imports", () => {
  it("imports only what the graph-execution package provides", () => {
    const files = sourceFiles(SERVER_DIR);
    expect(files.length).toBeGreaterThan(10);
    const failing: string[] = [];
    let checked = 0;
    for (const file of files) {
      for (const spec of bareImports(readFileSync(file, "utf8"))) {
        checked++;
        if (spec === "graph-execution/api" || spec.startsWith("node:") || engineDeps.includes(packageName(spec))) continue;
        failing.push(`${path.relative(SERVER_DIR, file).split(path.sep).join("/")}: ${spec}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(failing).toEqual([]);
  });

  it("finds every form of import", () => {
    const source = ['import a from "fastify";', "import type { B } from '@fastify/cookie/types';", 'import "node:fs";', 'const c = await import("node-pty");', 'import d from "./d.js";'].join("\n");
    expect(bareImports(source)).toEqual(["fastify", "@fastify/cookie/types", "node:fs", "node-pty"]);
    expect(packageName("@fastify/cookie/types")).toBe("@fastify/cookie");
    expect(packageName("zod/v4")).toBe("zod");
  });

  it("the engine depends on the packages only the manager uses", () => {
    expect(MANAGER_ONLY_DEPENDENCIES.filter((d) => !engineDeps.includes(d))).toEqual([]);
  });
});
