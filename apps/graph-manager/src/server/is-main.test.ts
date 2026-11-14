import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMain } from "./is-main.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

describe("isMain", () => {
  it("is true for the file node was started with and false for another one", () => {
    const file = path.join(dir, "m.js");
    const other = path.join(dir, "o.js");
    writeFileSync(file, "");
    writeFileSync(other, "");
    expect(isMain(pathToFileURL(file).href, file)).toBe(true);
    expect(isMain(pathToFileURL(file).href, other)).toBe(false);
    expect(isMain(pathToFileURL(file).href, undefined)).toBe(false);
    expect(isMain(pathToFileURL(file).href, path.join(dir, "missing.js"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("is true when argv[1] reaches the file through a symlinked folder", () => {
    const real = path.join(dir, "real");
    mkdirSync(real);
    writeFileSync(path.join(real, "m.js"), "");
    symlinkSync(real, path.join(dir, "link"));
    // Node's import.meta.url of the main module is the real path; argv[1] is the path as typed.
    expect(isMain(pathToFileURL(path.join(real, "m.js")).href, path.join(dir, "link", "m.js"))).toBe(true);
  });
});
