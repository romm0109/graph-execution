import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import * as gitModule from "../git/git.js";
import { ChangeTracker, DIFF_CAP_BYTES } from "./changes.js";
import { RunEmitter, type RunEventMap } from "./events.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("ChangeTracker finished nodes", () => {
  it("keeps the diff from git history after the worktree is gone, resets and seeds", async () => {
    const events = new RunEmitter();
    const tracker = new ChangeTracker(events, { intervalMs: 20 });
    const seen: RunEventMap["nodeChanges"][] = [];
    events.on("nodeChanges", (e) => seen.push(e));
    const base = await gitOut(repo, ["rev-parse", "HEAD"]);
    const wt = path.join(repo, "..", `wt-${path.basename(repo)}`);
    await gitOut(repo, ["worktree", "add", "-b", "b1", wt, base]);
    events.emit("changes:track", { nodeId: "t", worktree: wt, base });
    await writeFile(path.join(wt, "f.txt"), "one\n");
    await gitOut(wt, ["add", "-A"]);
    await gitOut(wt, ["commit", "-q", "-m", "f"]);
    events.emit("changes:stop", { nodeId: "t", repo, to: "b1" });
    await until(() => tracker.tracked("t")?.running === false);
    await gitOut(repo, ["worktree", "remove", "--force", wt]);
    expect(seen.at(-1)!.changes.files.map((f) => f.path)).toEqual(["f.txt"]);
    expect((await tracker.fileDiff("t", "f.txt"))!.diff).toContain("+one");

    events.emit("changes:reset", { nodeId: "t" });
    expect(seen.at(-1)!.changes.total).toEqual({ added: 0, deleted: 0, files: 0 });
    expect(tracker.isTracked("t")).toBe(false);

    await tracker.seed("s", repo, base, "b1");
    expect(seen.at(-1)).toMatchObject({ nodeId: "s", changes: { total: { files: 1 } } });
    expect((await tracker.fileDiff("s", "f.txt"))!.diff).toContain("+one");
    tracker.dispose();
  });
});

describe("ChangeTracker", () => {
  it("emits changed snapshots only, and stops polling on changes:stop", async () => {
    const events = new RunEmitter();
    const tracker = new ChangeTracker(events, { intervalMs: 20 });
    const seen: RunEventMap["nodeChanges"][] = [];
    events.on("nodeChanges", (e) => seen.push(e));
    const base = await gitOut(repo, ["rev-parse", "HEAD"]);

    events.emit("changes:track", { nodeId: "t", worktree: repo, base });
    await writeFile(path.join(repo, "f.txt"), "one\n");
    await until(() => seen.some((e) => e.changes.files.some((f) => f.path === "f.txt")));
    const count = seen.length;
    await sleep(100);
    expect(seen.length).toBe(count);

    events.emit("changes:stop", { nodeId: "t" });
    await until(() => tracker.tracked("t")?.running === false);
    const after = seen.length;
    await writeFile(path.join(repo, "g.txt"), "two\n");
    await sleep(200);
    expect(seen.length).toBe(after);
    expect(tracker.isTracked("t")).toBe(true);
    tracker.dispose();
  });

  it("never overlaps refreshes for one node", async () => {
    const real = gitModule.worktreeChanges;
    let active = 0;
    let maxActive = 0;
    vi.spyOn(gitModule, "worktreeChanges").mockImplementation(async (...args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(80);
      try {
        return await real(...args);
      } finally {
        active--;
      }
    });
    const events = new RunEmitter();
    const tracker = new ChangeTracker(events, { intervalMs: 10 });
    events.emit("changes:track", { nodeId: "t", worktree: repo, base: "HEAD" });
    await sleep(300);
    tracker.dispose();
    expect(maxActive).toBe(1);
  });
});

describe("ChangeTracker.fileDiff", () => {
  async function tracked() {
    const events = new RunEmitter();
    const tracker = new ChangeTracker(events, { intervalMs: 60_000 });
    const base = await gitOut(repo, ["rev-parse", "HEAD"]);
    events.emit("changes:track", { nodeId: "t", worktree: repo, base });
    return tracker;
  }

  it("diffs a modified tracked file", async () => {
    await writeFile(path.join(repo, "README.md"), "# test\nmore\n");
    const tracker = await tracked();
    const d = await tracker.fileDiff("t", "README.md");
    expect(d).toMatchObject({ path: "README.md", truncated: false, binary: false });
    expect(d!.diff).toContain("+more");
    tracker.dispose();
  });

  it("builds a diff for an untracked file", async () => {
    await writeFile(path.join(repo, "new.txt"), "a\nb\n");
    const tracker = await tracked();
    const d = await tracker.fileDiff("t", "new.txt");
    expect(d!.diff).toBe("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    tracker.dispose();
  });

  it("flags binary files, tracked or not", async () => {
    await writeFile(path.join(repo, "bin.dat"), Buffer.from([1, 0, 2]));
    const tracker = await tracked();
    expect(await tracker.fileDiff("t", "bin.dat")).toMatchObject({ binary: true, diff: "" });
    tracker.dispose();
  });

  it("truncates a diff over the cap", async () => {
    await writeFile(path.join(repo, "big.txt"), "x".repeat(99).concat("\n").repeat(5000));
    const tracker = await tracked();
    const d = await tracker.fileDiff("t", "big.txt");
    expect(d!.truncated).toBe(true);
    expect(Buffer.byteLength(d!.diff)).toBeLessThanOrEqual(DIFF_CAP_BYTES);
    expect(d!.diff.endsWith("\n")).toBe(true);
    tracker.dispose();
  });

  it("answers undefined for a node that is not tracked", async () => {
    const tracker = await tracked();
    expect(await tracker.fileDiff("nope", "README.md")).toBeUndefined();
    tracker.dispose();
  });
});
