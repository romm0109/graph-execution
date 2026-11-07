import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { rangeChanges, rangeFileDiff, worktreeChanges } from "./git.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("worktreeChanges", () => {
  it("lists commits, uncommitted and untracked changes, not ignored files", async () => {
    const w = (name: string, content: string | Buffer): Promise<void> => writeFile(path.join(repo, name), content);
    await w("a.txt", "1\n2\n3\n");
    await w("b.bin", Buffer.from([1, 0, 2]));
    await w("gone.txt", "bye\n");
    await w(".gitignore", "ignored/\n");
    await execa("git", ["add", "-A"], { cwd: repo });
    await execa("git", ["commit", "-q", "-m", "base"], { cwd: repo });
    const base = await gitOut(repo, ["rev-parse", "HEAD"]);

    await w("a.txt", "1\n3\n4\n5\n");
    await rm(path.join(repo, "gone.txt"));
    await w("new.txt", "x\ny\n");
    await mkdir(path.join(repo, "ignored"));
    await w("ignored/x.txt", "nope\n");
    await w("b.bin", Buffer.from([9, 0, 9, 9]));
    await w("c.txt", "c\n");
    await execa("git", ["add", "c.txt"], { cwd: repo });
    await execa("git", ["commit", "-q", "-m", "c"], { cwd: repo });

    const files = await worktreeChanges(repo, base);
    expect(files).toEqual([
      { path: "a.txt", added: 2, deleted: 1 },
      { path: "b.bin", added: 0, deleted: 0, binary: true },
      { path: "c.txt", added: 1, deleted: 0, isNew: true },
      { path: "gone.txt", added: 0, deleted: 1, isDeleted: true },
      { path: "new.txt", added: 2, deleted: 0, isNew: true },
    ]);
    expect((await worktreeChanges(repo, base, ["new.txt"])).map((f) => f.path)).not.toContain("new.txt");
  });
});

describe("rangeChanges / rangeFileDiff", () => {
  it("diffs two commits: modified, new, deleted and binary files", async () => {
    const w = (name: string, content: string | Buffer): Promise<void> => writeFile(path.join(repo, name), content);
    const commit = async (): Promise<string> => {
      await execa("git", ["add", "-A"], { cwd: repo });
      await execa("git", ["commit", "-q", "-m", "c"], { cwd: repo });
      return gitOut(repo, ["rev-parse", "HEAD"]);
    };
    await w("mod.txt", "1\n2\n");
    await w("gone.txt", "bye\n");
    const from = await commit();
    await w("mod.txt", "1\n2\n3\n");
    await w("new.txt", "a\nb\n");
    await w("b.bin", Buffer.from([1, 0, 2]));
    await rm(path.join(repo, "gone.txt"));
    const to = await commit();

    const files = await rangeChanges(repo, from, to);
    expect(files.map((f) => f.path)).toEqual(["b.bin", "gone.txt", "mod.txt", "new.txt"]);
    expect(files.find((f) => f.path === "mod.txt")).toMatchObject({ added: 1, deleted: 0 });
    expect(files.find((f) => f.path === "new.txt")).toMatchObject({ added: 2, isNew: true });
    expect(files.find((f) => f.path === "gone.txt")).toMatchObject({ deleted: 1, isDeleted: true });
    expect(files.find((f) => f.path === "b.bin")?.binary).toBe(true);
    expect(await rangeFileDiff(repo, from, to, "mod.txt")).toContain("+3");
  });
});
