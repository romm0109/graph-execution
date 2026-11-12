import { statSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixSpawnHelper, nodePtyDir } from "./pty-helper.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let helper: string;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("gm-pty-"));
  helper = path.join(dir, "prebuilds", "darwin-arm64", "spawn-helper");
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(helper, "x");
  await chmod(helper, 0o644);
});
afterEach(async () => {
  await cleanup();
});

describe("fixSpawnHelper", () => {
  it("makes the spawn-helper files that exist executable on macOS", () => {
    expect(fixSpawnHelper("darwin", dir)).toEqual([helper]);
    if (process.platform !== "win32") expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it("does nothing on another platform", () => {
    expect(fixSpawnHelper("linux", dir)).toEqual([]);
    if (process.platform !== "win32") expect(statSync(helper).mode & 0o777).toBe(0o644);
  });

  it("does nothing when node-pty is not found", () => {
    expect(fixSpawnHelper("darwin", undefined)).toEqual([]);
    expect(fixSpawnHelper("darwin", path.join(dir, "missing"))).toEqual([]);
  });

  it("finds the installed node-pty", () => {
    expect(path.basename(nodePtyDir() ?? "")).toBe("node-pty");
  });
});
