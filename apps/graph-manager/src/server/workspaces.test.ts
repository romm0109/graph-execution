import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers.js";
import { insideWorkspaces, listWorkspaces, resolveWorkspace } from "./workspaces.js";

let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir: root, cleanup } = await tempDir());
  await mkdir(path.join(root, "github/octo/hello/.git"), { recursive: true });
  await mkdir(path.join(root, "gitlab/grp/sub/proj/.git"), { recursive: true });
  // A nested checkout inside a workspace is not listed, nor is anything under node_modules or a dot-dir.
  await mkdir(path.join(root, "github/octo/hello/vendor/inner/.git"), { recursive: true });
  await mkdir(path.join(root, "github/node_modules/x/.git"), { recursive: true });
  await mkdir(path.join(root, ".hidden/a/b/.git"), { recursive: true });
  await mkdir(path.join(root, "github/octo/empty"), { recursive: true });
});
afterEach(() => cleanup());

describe("workspaces", () => {
  it("lists the checkouts with forge and fullPath", async () => {
    const list = await listWorkspaces(root);
    expect(list.map((w) => w.id)).toEqual(["github~octo~hello", "gitlab~grp~sub~proj"]);
    expect(list[0]).toMatchObject({ forge: "github", fullPath: "octo/hello", rel: "github/octo/hello", path: path.join(root, "github/octo/hello") });
    expect(list[1]).toMatchObject({ forge: "gitlab", fullPath: "grp/sub/proj" });
  });

  it("returns an empty list for a missing root", async () => {
    expect(await listWorkspaces(path.join(root, "missing"))).toEqual([]);
  });

  it("resolves ids and rejects unsafe or unknown ones", () => {
    expect(resolveWorkspace(root, "gitlab~grp~sub~proj")?.path).toBe(path.join(root, "gitlab/grp/sub/proj"));
    expect(resolveWorkspace(root, "..~x")).toBeUndefined();
    expect(resolveWorkspace(root, "github~..~..")).toBeUndefined();
    expect(resolveWorkspace(root, "/etc~passwd")).toBeUndefined();
    expect(resolveWorkspace(root, "github/octo/hello")).toBeUndefined();
    expect(resolveWorkspace(root, "github~octo~empty")).toBeUndefined();
    expect(resolveWorkspace(root, "github~octo~nope")).toBeUndefined();
    expect(resolveWorkspace(root, "")).toBeUndefined();
  });

  it("checks containment", () => {
    expect(insideWorkspaces(root, path.join(root, "a"))).toBe(true);
    expect(insideWorkspaces(root, root)).toBe(false);
    expect(insideWorkspaces(root, path.join(root, "..", "x"))).toBe(false);
    expect(insideWorkspaces(root, `${root}-other/x`)).toBe(false);
  });
});
