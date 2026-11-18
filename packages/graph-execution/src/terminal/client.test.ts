import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIRST_PING_MS, PING_MS, reconnectDelay, toCtrl } from "./client.js";

describe("toCtrl", () => {
  it.each([
    ["a", "\x01"],
    ["A", "\x01"],
    ["c", "\x03"],
    ["z", "\x1a"],
    ["[", "\x1b"],
    ["@", "\x00"],
    ["_", "\x1f"],
  ])("%j becomes its control code", (ch, code) => expect(toCtrl(ch)).toBe(code));

  it.each(["1", "ab", "\x1b[A", ""])("%j is left alone", (ch) => expect(toCtrl(ch)).toBeNull());
});

describe("reconnectDelay", () => {
  it("doubles from 0.5 s up to 5 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(reconnectDelay(-1)).toBe(500);
  });

  it("pings after the replay, then every PING_MS", () => {
    expect(FIRST_PING_MS).toBeLessThan(PING_MS);
  });
});

/** The specifiers of runtime imports (not `import type`) in a TypeScript source. */
function runtimeImports(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm)) found.push(m[2]!);
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(m[1]!);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]!);
  return found;
}

describe("the browser modules", () => {
  it("have no bare imports (the run page loads them without a bundler)", () => {
    for (const file of ["client.ts", "echo.ts", "touch.ts"]) {
      const specs = runtimeImports(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
      expect(specs.filter((s) => !s.startsWith("./")), file).toEqual([]);
    }
    expect(runtimeImports(readFileSync(new URL("./client.ts", import.meta.url), "utf8")).sort()).toEqual(["./echo.js", "./echo.js", "./touch.js", "./touch.js"]);
  });
});

describe("node-pty", () => {
  it("is loaded by no terminal module at import time, only by createPtySession", () => {
    const dir = new URL("./", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      const top = runtimeImports(source.replace(/\bimport\s*\(\s*["']node-pty["']\s*\)/g, ""));
      expect(top, file).not.toContain("node-pty");
    }
    expect(readFileSync(new URL("./pty.ts", import.meta.url), "utf8")).toContain('await import("node-pty")');
  });

  it("is not imported by api.ts", () => {
    expect(runtimeImports(readFileSync(new URL("../api.ts", import.meta.url), "utf8"))).not.toContain("node-pty");
  });
});
