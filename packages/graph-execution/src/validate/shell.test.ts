import { describe, expect, it } from "vitest";
import { posixShell, SHELL_ENV } from "./shell.js";

// Windows resolution, simulated so it runs on every platform (GE-17).
const on = (found: Record<string, string>) => (bin: string) => found[bin];
const files = (...paths: string[]) => (file: string) => paths.some((p) => p.toLowerCase() === file.toLowerCase());
const GIT = "C:\\Program Files\\Git";

describe("posixShell", () => {
  it("leaves POSIX on its default /bin/sh", () => {
    expect(posixShell({}, "linux", on({ sh: "/bin/sh" }))).toBeUndefined();
    expect(posixShell({ [SHELL_ENV]: "/bin/bash" }, "darwin")).toBeUndefined();
  });

  it("uses sh on the PATH", () => {
    expect(posixShell({}, "win32", on({ sh: "C:\\msys64\\usr\\bin\\sh.exe" }), files())).toBe("C:\\msys64\\usr\\bin\\sh.exe");
  });

  it.each([
    ["cmd", `${GIT}\\cmd\\git.exe`],
    ["bin", `${GIT}\\bin\\git.exe`],
    ["mingw64\\bin", `${GIT}\\mingw64\\bin\\git.exe`],
  ])("finds Git for Windows' sh.exe from git in %s", (_where, git) => {
    expect(posixShell({}, "win32", on({ git }), files(`${GIT}\\bin\\sh.exe`))).toBe(`${GIT}\\bin\\sh.exe`);
    expect(posixShell({}, "win32", on({ git }), files(`${GIT}\\usr\\bin\\sh.exe`))).toBe(`${GIT}\\usr\\bin\\sh.exe`);
  });

  it("falls back to cmd.exe when no sh can be found", () => {
    expect(posixShell({}, "win32", on({}), files())).toBeUndefined();
    expect(posixShell({}, "win32", on({ git: "C:\\other\\git.exe" }), files())).toBeUndefined();
  });

  it("lets GRAPH_EXECUTION_SHELL pick cmd.exe or another sh", () => {
    const find = on({ sh: "C:\\x\\sh.exe" });
    expect(posixShell({ [SHELL_ENV]: "cmd" }, "win32", find, files())).toBeUndefined();
    expect(posixShell({ [SHELL_ENV]: "CMD.EXE" }, "win32", find, files())).toBeUndefined();
    expect(posixShell({ [SHELL_ENV]: "D:\\tools\\bash.exe" }, "win32", find, files())).toBe("D:\\tools\\bash.exe");
  });
});
