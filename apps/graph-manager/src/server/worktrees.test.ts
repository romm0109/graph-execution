import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers.js";
import { addTerminalWorktree, git, WORKTREES_DIR, WorktreeError } from "./worktrees.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  await execa("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(path.join(dir, "a.txt"), "a\n");
  await execa("git", ["-C", dir, "add", "."]);
  await execa("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await cleanup();
});

describe("git", () => {
  it.skipIf(process.platform === "win32")("settles at the timeout even when a child of git keeps the pipes open", async () => {
    const start = Date.now();
    // A shell alias runs `sleep` as a child of git, like `git-remote-http` during a fetch.
    const res = await git(dir, ["-c", "alias.slow=!sleep 30", "slow"], { timeout: 500 });
    expect(res).toMatchObject({ ok: false, stderr: "timed out" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("addTerminalWorktree", () => {
  it("removes the branch a failed git worktree add created", async () => {
    // A regular file where the worktrees folder should be makes `git worktree add` fail after it made the branch.
    await writeFile(path.join(dir, WORKTREES_DIR), "not a folder\n");
    await expect(addTerminalWorktree(dir, { id: "w00000001", strict: true })).rejects.toBeInstanceOf(WorktreeError);
    const branches = await git(dir, ["branch", "--list", "gm-term/*"]);
    expect(branches.stdout).toBe("");
  });

  it("keeps a branch that existed before the failed add", async () => {
    await git(dir, ["branch", "gm-term/w00000002"]);
    await expect(addTerminalWorktree(dir, { id: "w00000002", strict: true })).rejects.toBeInstanceOf(WorktreeError);
    const branches = await git(dir, ["branch", "--list", "gm-term/*"]);
    expect(branches.stdout).toContain("gm-term/w00000002");
  });
});
