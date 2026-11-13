import { describe, expect, it } from "vitest";
import { containerRoot, toContainer, toContainerArgs, toHost } from "./sandbox-paths.js";
import type { Workspace } from "./workspaces.js";

const win: Workspace = { id: "github~octo~hello", path: "C:\\Users\\Me\\gm-ws\\github\\octo\\hello", rel: "github/octo/hello", forge: "github", fullPath: "octo/hello" };
const posix: Workspace = { ...win, path: "/tmp/gm/ws/github/octo/hello" };
const ROOT = "/workspaces/github/octo/hello";

describe("containerRoot", () => {
  it("is /workspaces/<rel> on win32 and the workspace's own path elsewhere", () => {
    expect(containerRoot(win, "win32")).toBe(ROOT);
    expect(containerRoot(posix, "win32")).toBe(ROOT);
    expect(containerRoot(win, "linux")).toBe(win.path);
    expect(containerRoot(posix, "darwin")).toBe(posix.path);
    const nested: Workspace = { ...win, id: "gitlab~group~sub~repo", rel: "gitlab/group/sub/repo", forge: "gitlab", fullPath: "group/sub/repo" };
    expect(containerRoot(nested, "win32")).toBe("/workspaces/gitlab/group/sub/repo");
  });
});

describe("toContainer", () => {
  it.each<[string, Workspace, string, NodeJS.Platform, string]>([
    ["the workspace", win, win.path, "win32", ROOT],
    ["the workspace with a trailing \\", win, `${win.path}\\`, "win32", ROOT],
    ["another case, keeping the rest's own", win, "c:\\users\\me\\GM-WS\\github\\octo\\hello\\Docs\\a.md", "win32", `${ROOT}/Docs/a.md`],
    ["forward slashes", win, "C:/Users/Me/gm-ws/github/octo/hello/.graph-execution/gm-1", "win32", `${ROOT}/.graph-execution/gm-1`],
    ["mixed separators", win, `${win.path}/.graph-execution\\gm-1\\.ready.json`, "win32", `${ROOT}/.graph-execution/gm-1/.ready.json`],
    ["a .. segment", win, `${win.path}\\docs\\..\\spec.md`, "win32", `${ROOT}/spec.md`],
    ["a POSIX workspace", posix, `${posix.path}/.graph-execution/r`, "win32", `${ROOT}/.graph-execution/r`],
    ["a POSIX workspace itself", posix, posix.path, "win32", ROOT],
  ])("maps %s", (_name, ws, input, platform, expected) => {
    expect(toContainer(ws, input, platform)).toBe(expected);
  });

  it.each<[string, Workspace, string, NodeJS.Platform]>([
    ["a sibling with the same prefix", win, "C:\\Users\\Me\\gm-ws\\github\\octo\\hello-2\\x", "win32"],
    ["another workspace", win, "C:\\Users\\Me\\gm-ws\\github\\octo\\other\\x", "win32"],
    ["another drive", win, "D:\\x", "win32"],
    ["a relative path", win, "docs\\a.md", "win32"],
    ["a path on linux", win, `${win.path}\\a`, "linux"],
    ["a path on darwin", posix, `${posix.path}/a`, "darwin"],
  ])("leaves %s unchanged", (_name, ws, input, platform) => {
    expect(toContainer(ws, input, platform)).toBe(input);
  });
});

describe("toHost", () => {
  it.each<[string, Workspace, string, NodeJS.Platform, string]>([
    ["the root", win, ROOT, "win32", win.path],
    ["the root with a trailing /", win, `${ROOT}/`, "win32", win.path],
    ["a file, with the workspace's separator", win, `${ROOT}/docs/prd/a.md`, "win32", `${win.path}\\docs\\prd\\a.md`],
    ["a folder of a POSIX workspace", posix, `${ROOT}/tasks`, "win32", "/tmp/gm/ws/github/octo/hello/tasks"],
  ])("maps %s", (_name, ws, input, platform, expected) => {
    expect(toHost(ws, input, platform)).toBe(expected);
  });

  it.each<[string, string, NodeJS.Platform]>([
    ["a sibling with the same prefix", "/workspaces/github/octo/hello-2/x", "win32"],
    ["another case", "/workspaces/GitHub/octo/hello/x", "win32"],
    ["the tools", "/opt/gm-tools/x", "win32"],
    ["a Windows path", "C:\\x", "win32"],
    ["a relative path", "spec.md", "win32"],
    ["a path on linux", `${ROOT}/a`, "linux"],
  ])("leaves %s unchanged", (_name, input, platform) => {
    expect(toHost(win, input, platform)).toBe(input);
  });

  it("is the inverse of toContainer inside the workspace", () => {
    for (const ws of [win, posix]) {
      const sep = ws === win ? "\\" : "/";
      const host = `${ws.path}${sep}.graph-execution${sep}gm-1`;
      expect(toHost(ws, toContainer(ws, host, "win32"), "win32")).toBe(host);
    }
  });
});

describe("toContainerArgs", () => {
  const cases: [string, string[], string[]][] = [
    [
      "absolute paths",
      [`${win.path}\\tasks\\x`, "--spec", `${win.path}\\docs\\x.md`, "--provider", "fake"],
      [`${ROOT}/tasks/x`, "--spec", `${ROOT}/docs/x.md`, "--provider", "fake"],
    ],
    [
      "relative paths with backslashes",
      [".agents\\tasks\\x", "--spec=docs\\prd\\x.md", "--reviewers", ".\\r.json", "--model", "a\\b"],
      [".agents/tasks/x", "--spec=docs/prd/x.md", "--reviewers", "./r.json", "--model", "a\\b"],
    ],
    [
      "only the first positional",
      ["--concurrency", "2", "tasks", "--spec", "spec.md", "extra\\word"],
      ["--concurrency", "2", "tasks", "--spec", "spec.md", "extra\\word"],
    ],
    ["a resume", ["--resume", "--run", "gm-1"], ["--resume", "--run", "gm-1"]],
    ["a --content file", ["--content", "docs\\c.md", "--provider", "fake"], ["--content", "docs/c.md", "--provider", "fake"]],
    ["a --refs file", ["--content", "c.md", "--refs", "docs\\r.json"], ["--content", "c.md", "--refs", "docs/r.json"]],
    [
      "--refs and --replan files",
      ["--content", ".graph-execution\\gm-1\\inputs\\content.md", "--refs", "in\\refs.json", "--replan", "in\\f.md"],
      ["--content", ".graph-execution/gm-1/inputs/content.md", "--refs", "in/refs.json", "--replan", "in/f.md"],
    ],
    ["a --replan file", ["--resume", "--run", "gm-1", "--replan", "docs\\fb.md"], ["--resume", "--run", "gm-1", "--replan", "docs/fb.md"]],
    ["paths outside the workspace", ["D:\\other\\tasks", "--spec", "D:\\other\\s.md"], ["D:\\other\\tasks", "--spec", "D:\\other\\s.md"]],
    ["a positional after --", ["--provider", "fake", "--", "a\\b", "--spec", "c\\d"], ["--provider", "fake", "--", "a/b", "--spec", "c\\d"]],
    ["an absolute --reviewers=", ["t", `--reviewers=${win.path}\\r.json`], ["t", `--reviewers=${ROOT}/r.json`]],
  ];

  it.each(cases)("maps %s on win32", (_name, input, expected) => {
    const before = [...input];
    expect(toContainerArgs(win, input, "win32")).toEqual(expected);
    expect(input).toEqual(before);
  });

  it.each(cases)("copies %s unchanged on linux", (_name, input) => {
    const out = toContainerArgs(win, input, "linux");
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});
