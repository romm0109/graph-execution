import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { buildReviewerContext } from "./context.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function commitFile(name: string, content: string): Promise<void> {
  await writeFile(path.join(repo, name), content);
  await execa("git", ["add", "-A"], { cwd: repo });
  await execa("git", ["commit", "-q", "-m", `add ${name}`], { cwd: repo });
}

describe("buildReviewerContext", () => {
  it("returns the spec, the absolute tasks path and the diff, without REVIEW.md when absent", async () => {
    const start = await gitOut(repo, ["rev-parse", "HEAD"]);
    await commitFile("a.txt", "hello\n");
    await mkdir(path.join(repo, ".git", "spec"), { recursive: true });
    const specPath = path.join(repo, ".git", "spec", "spec.md");
    await writeFile(specPath, "# Spec\nBuild a.\n");

    const ctx = await buildReviewerContext({
      specPath,
      tasksDir: path.relative(process.cwd(), path.join(repo, "tasks")),
      repoRoot: repo,
      startingCommit: start,
      integrationWorktree: repo,
    });
    expect(ctx.spec).toBe("# Spec\nBuild a.\n");
    expect(ctx.tasksDir).toBe(path.join(repo, "tasks"));
    expect(ctx.diff).toContain("+++ b/a.txt");
    expect(ctx.diff).toContain("+hello");
    expect(ctx.changedFiles).toEqual(["a.txt"]);
    expect(ctx).not.toHaveProperty("reviewMd");
    expect(ctx).not.toHaveProperty("testingMd");
  });

  it("reads REVIEW.md and TESTING.md from the repo root even when they are not committed", async () => {
    await writeFile(path.join(repo, "REVIEW.md"), "No console.log.\n");
    await writeFile(path.join(repo, "TESTING.md"), "npm start, then open /.\n");
    const ctx = await buildReviewerContext({
      specPath: path.join(repo, "README.md"),
      tasksDir: repo,
      repoRoot: repo,
      startingCommit: await gitOut(repo, ["rev-parse", "HEAD"]),
      integrationWorktree: repo,
    });
    expect(ctx.reviewMd).toBe("No console.log.\n");
    expect(ctx.testingMd).toBe("npm start, then open /.\n");
    expect(ctx.diff).toBe("");
    expect(ctx.changedFiles).toEqual([]);
  });
});
