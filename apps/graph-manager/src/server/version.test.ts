import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers.js";
import { gmVersion } from "./version.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("gm-version-"));
});
afterEach(async () => {
  await cleanup();
});

async function pkg(folder: string, name: string, version: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "package.json"), JSON.stringify({ name, version }));
}

describe("gmVersion", () => {
  it("is the version in apps/graph-manager/package.json", () => {
    const own = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(gmVersion()).toBe(own.version);
  });

  it("reads the package.json next to the server folder (the bundled layout)", async () => {
    await pkg(dir, "graph-manager", "9.9.9");
    expect(gmVersion(pathToFileURL(path.join(dir, "server", "x.js")))).toBe("9.9.9");
  });

  it("skips a nearer package.json of another package", async () => {
    await pkg(dir, "graph-manager", "9.9.9");
    await pkg(path.join(dir, "dist"), "graph-execution", "1.0.0");
    expect(gmVersion(pathToFileURL(path.join(dir, "dist", "server", "x.js")))).toBe("9.9.9");
  });

  it("throws when there is no graph-manager package.json", async () => {
    await pkg(dir, "graph-execution", "1.0.0");
    expect(() => gmVersion(pathToFileURL(path.join(dir, "server", "x.js")))).toThrow("cannot find graph-manager's package.json");
    expect(() => gmVersion(pathToFileURL(path.join(dir, "a", "b", "server", "x.js")))).toThrow("cannot find graph-manager's package.json");
  });
});
