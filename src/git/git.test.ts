import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import {
  addWorktree,
  currentHead,
  ensureExcluded,
  hasNewCommit,
  hideFromGit,
  merge,
  removeWorktreeIfPresent,
  resetHard,
  unhideFromGit,
  untrackedPaths,
} from "./git.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const commitFile = async (cwd: string, name: string, content: string): Promise<void> => {
  await writeFile(path.join(cwd, name), content);
  await execa("git", ["add", "-A"], { cwd });
  await execa("git", ["commit", "-q", "-m", `edit ${name}`], { cwd });
};

describe("git", () => {
  it("removeWorktreeIfPresent removes a worktree with paths over 260 characters", async () => {
    const wt = path.join(repo, ".graph-execution", "wt");
    await ensureExcluded(repo, ".graph-execution/");
    await addWorktree(repo, wt, "deep", await currentHead(repo));
    // Like a nested run's node_modules: far past Windows' 260-character limit, which git there cannot delete
    // without core.longpaths.
    const deep = path.join(wt, ...Array.from({ length: 12 }, (_, i) => `node_modules-${i}-${"x".repeat(20)}`));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "index.d.ts"), "export {};\n");
    expect(deep.length).toBeGreaterThan(260);

    await removeWorktreeIfPresent(repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(await gitOut(repo, ["worktree", "list"])).not.toContain("wt");
  });

  it("removeWorktreeIfPresent deletes a folder git does not know as a worktree", async () => {
    const dir = path.join(repo, ".graph-execution", "stray");
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "f.txt"), "x");
    await removeWorktreeIfPresent(repo, dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("ensureExcluded is idempotent", async () => {
    await ensureExcluded(repo, ".graph-execution/");
    await ensureExcluded(repo, ".graph-execution/");
    const lines = (await readFile(path.join(repo, ".git/info/exclude"), "utf8")).split("\n");
    expect(lines.filter((l) => l === ".graph-execution/")).toHaveLength(1);
  });

  it("hideFromGit keeps untracked files through a reset until unhideFromGit", async () => {
    await ensureExcluded(repo, ".graph-execution/");
    await mkdir(path.join(repo, "my dir"));
    await writeFile(path.join(repo, "my dir", "a.txt"), "mine\n");
    await writeFile(path.join(repo, "notes[1].md"), "mine\n");
    const untracked = await untrackedPaths(repo);
    expect(untracked.sort()).toEqual(["my dir/", "notes[1].md"]);

    await hideFromGit(repo, "run-1", untracked);
    await hideFromGit(repo, "run-1", untracked);
    await writeFile(path.join(repo, "agent.txt"), "junk\n");
    expect(await untrackedPaths(repo)).toEqual(["agent.txt"]);
    await resetHard(repo, "HEAD");
    expect(existsSync(path.join(repo, "agent.txt"))).toBe(false);
    expect(existsSync(path.join(repo, "my dir", "a.txt"))).toBe(true);
    expect(existsSync(path.join(repo, "notes[1].md"))).toBe(true);

    await unhideFromGit(repo, "run-1");
    expect((await untrackedPaths(repo)).sort()).toEqual(["my dir/", "notes[1].md"]);
    expect(await readFile(path.join(repo, ".git/info/exclude"), "utf8")).not.toContain("run-1");
    expect(await readFile(path.join(repo, ".git/info/exclude"), "utf8")).toContain(".graph-execution/");
  });

  it("detects new commits and merges with --no-ff", async () => {
    const base = await currentHead(repo);
    const wt = path.join(repo, ".graph-execution", "wt");
    await ensureExcluded(repo, ".graph-execution/");
    await addWorktree(repo, wt, "feature", base);
    expect(await hasNewCommit(wt, base)).toBe(false);
    await commitFile(wt, "a.txt", "a");
    expect(await hasNewCommit(wt, base)).toBe(true);

    expect(await merge(repo, "feature")).toEqual({ ok: true });
    expect(await gitOut(repo, ["rev-list", "--count", "--merges", "HEAD"])).toBe("1");
  });

  it("leaves a conflicted merge in place and lists the files", async () => {
    const base = await currentHead(repo);
    const wt = path.join(repo, ".graph-execution", "wt");
    await ensureExcluded(repo, ".graph-execution/");
    await addWorktree(repo, wt, "feature", base);
    await commitFile(wt, "README.md", "theirs\n");
    await commitFile(repo, "README.md", "ours\n");

    expect(await merge(repo, "feature")).toEqual({ ok: false, conflicted: ["README.md"] });
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toContain("<<<<<<<");
  });
});
