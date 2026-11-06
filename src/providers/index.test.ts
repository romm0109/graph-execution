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

  describe("on Windows (GE-15), with a simulated file system", () => {
    /** A `stat` over a set of Windows paths, compared case-insensitively like NTFS. */
    const files = (...paths: string[]) => {
      const set = new Set(paths.map((f) => f.toLowerCase()));
      return (file: string) => {
        if (!set.has(file.toLowerCase())) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isFile: () => true, mode: 0 };
      };
    };
    const env = { Path: "C:\\npm;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    it("takes npm's claude.cmd, not the extensionless sh shim beside it", () => {
      const stat = files("C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\npm\\claude.ps1");
      expect(findOnPath("claude", "C:\\repo", env, "win32", stat)?.toLowerCase()).toBe("c:\\npm\\claude.cmd");
    });

    it("never takes a bare extensionless file", () => {
      expect(findOnPath("claude", "C:\\repo", env, "win32", files("C:\\npm\\claude"))).toBeUndefined();
    });

    it("tries the PATHEXT extensions in order within a directory, and directories in PATH order", () => {
      const stat = files("C:\\npm\\codex.CMD", "C:\\npm\\codex.exe", "C:\\tools\\codex.com");
      expect(findOnPath("codex", "C:\\repo", env, "win32", stat)?.toLowerCase()).toBe("c:\\npm\\codex.exe");
    });

    it("takes a name that already has a PATHEXT extension as is", () => {
      const stat = files("C:\\tools\\git.exe", "C:\\tools\\git.exe.cmd");
      expect(findOnPath("git.exe", "C:\\repo", env, "win32", stat)?.toLowerCase()).toBe("c:\\tools\\git.exe");
    });

    it("falls back to the default PATHEXT and reads env names in any case", () => {
      const stat = files("C:\\npm\\qwen.bat");
      expect(findOnPath("qwen", "C:\\repo", { PATH: "C:\\npm" }, "win32", stat)?.toLowerCase()).toBe("c:\\npm\\qwen.bat");
    });
  });
});
