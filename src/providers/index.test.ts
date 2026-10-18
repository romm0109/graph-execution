import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOnPath } from "./index.js";

describe("findOnPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ge-path-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it.runIf(process.platform !== "win32")("finds an executable file in a PATH directory", async () => {
    const bin = path.join(dir, "tool");
    await writeFile(bin, "");
    await chmod(bin, 0o755);
    expect(findOnPath("tool", dir, { PATH: ["/nowhere", dir].join(path.posix.delimiter) }, "linux")).toBe(bin);
  });

  it.runIf(process.platform !== "win32")("skips a POSIX file without an execute bit, and a missing one", async () => {
    await writeFile(path.join(dir, "tool"), "");
    await chmod(path.join(dir, "tool"), 0o644);
    expect(findOnPath("tool", dir, { PATH: dir }, "darwin")).toBeUndefined();
    expect(findOnPath("other", dir, { PATH: dir }, "darwin")).toBeUndefined();
    expect(findOnPath("tool", dir, {}, "darwin")).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("on Windows tries the PATHEXT extensions and reads `Path` in any case", async () => {
    await writeFile(path.join(dir, "claude.CMD"), "");
    const found = findOnPath("claude", dir, { Path: dir, PATHEXT: ".EXE;.CMD" });
    expect(found && path.basename(found)).toBe("claude.CMD");
  });
});
