import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { execa } from "execa";
import { summaryLines } from "../ui/Summary.js";
import { RunEmitter, type RunEnd } from "./events.js";
import { repo, runDiamond, onReview } from "../__fixtures__/run-diamond.js";

describe("applying the result to the starting branch", () => {
  const ends = (events: RunEmitter): RunEnd[] => {
    const out: RunEnd[] = [];
    events.on("run:end", (end) => out.push(end));
    return out;
  };

  it("reports the uncommitted changes and the run's commits", async () => {
    const events = new RunEmitter();
    const seen = ends(events);
    const { result } = await runDiamond(createFakeProvider(), undefined, { events });
    expect(result.exitCode).toBe(0);
    const merge = seen[0]!.merge!;
    expect(merge).toMatchObject({ target: "main", ok: true });
    expect(merge.files.map((f) => f.path).sort()).toEqual(["1.txt", "2.txt", "3.txt", "4.txt"]);
    expect(merge.files.every((f) => f.added > 0 && f.isNew)).toBe(true);
    expect(merge.commits).toHaveLength(4);
    // Git's squash message is left for `git commit`.
    expect(await readFile(path.join(repo, ".git", "SQUASH_MSG"), "utf8")).toContain("fake: task:1 attempt 1");
  });

  it("can be dropped completely with the summary's command, leaving the user's own files alone", async () => {
    // A tracked file the run modifies, next to the new files it creates.
    await writeFile(path.join(repo, "1.txt"), "old\n");
    await gitOut(repo, ["add", "1.txt"]);
    await gitOut(repo, ["commit", "-q", "-m", "add 1.txt"]);
    await writeFile(path.join(repo, "notes.txt"), "mine\n");
    const events = new RunEmitter();
    const seen = ends(events);
    await runDiamond(createFakeProvider(), undefined, { events });
    const merge = seen[0]!.merge!;
    expect(merge.files.find((f) => f.path === "1.txt")!.isNew).toBeUndefined();
    const drop = summaryLines(seen[0]!).find((l) => l.includes("drop them:"))!;
    const command = /drop them: (.*) \(also/.exec(drop)![1]!;
    expect(command).toBe("git restore . && git clean -f -- 2.txt 3.txt 4.txt");
    await execa(command, { cwd: repo, shell: true });
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("?? notes.txt");
    expect(await readFile(path.join(repo, "1.txt"), "utf8")).toBe("old\n");
  });

  it("leaves the starting branch alone with --no-merge", async () => {
    const events = new RunEmitter();
    const seen = ends(events);
    const { result } = await runDiamond(createFakeProvider(), undefined, { merge: false, events });
    expect(result.exitCode).toBe(0);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    expect(seen[0]!.merge).toBeUndefined();
  });

  it("does not apply when the user switched branches during the run", async () => {
    const provider = onReview(createFakeProvider(), () => gitOut(repo, ["switch", "-q", "-c", "elsewhere"]));
    const events = new RunEmitter();
    const seen = ends(events);
    const { result } = await runDiamond(provider, undefined, { events });
    expect(result.exitCode).toBe(0);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    expect(seen[0]!.merge).toMatchObject({ ok: false, reason: expect.stringContaining("on elsewhere, not on main") });
  });

  /** The summary's drop command, run in the checkout. */
  const drop = async (end: RunEnd): Promise<void> => {
    const line = summaryLines(end).find((l) => l.includes("drop them"))!;
    await execa(/: (git .*?)(?: \(also|$)/.exec(line)![1]!, { cwd: repo, shell: true });
  };

  it("applies on top of uncommitted changes to tracked files, keeping them and a backup", async () => {
    await writeFile(path.join(repo, "README.md"), "# edited\n");
    const events = new RunEmitter();
    const seen = ends(events);
    await runDiamond(createFakeProvider(), undefined, { events });
    const merge = seen[0]!.merge!;
    expect(merge).toMatchObject({ ok: true, conflicts: [], backup: expect.stringMatching(/^[0-9a-f]{40}$/) });
    // Only the run's changes are listed; the user's edit is still there, unstaged.
    expect(merge.files.map((f) => f.path).sort()).toEqual(["1.txt", "2.txt", "3.txt", "4.txt"]);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# edited\n");
    expect(await gitOut(repo, ["diff", "--name-only"])).toContain("README.md");
    expect(await gitOut(repo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await gitOut(repo, ["stash", "list"])).toContain("graph-execution: your changes before applying graph/");
    expect(await readFile(path.join(repo, ".git", "SQUASH_MSG"), "utf8")).toContain("fake: task:1 attempt 1");

    await drop(seen[0]!);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("M README.md");
    expect(await gitOut(repo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# edited\n");
  });

  it("leaves a file both the run and the user's uncommitted edit changed as a merge conflict", async () => {
    await writeFile(path.join(repo, "1.txt"), "old\n");
    await gitOut(repo, ["add", "1.txt"]);
    await gitOut(repo, ["commit", "-q", "-m", "add 1.txt"]);
    await writeFile(path.join(repo, "1.txt"), "mine\n");
    const events = new RunEmitter();
    const seen = ends(events);
    await runDiamond(createFakeProvider(), undefined, { events });
    const merge = seen[0]!.merge!;
    expect(merge).toMatchObject({ ok: true, conflicts: ["1.txt"] });
    expect(merge.files.map((f) => f.path).sort()).toEqual(["2.txt", "3.txt", "4.txt"]);
    expect(await gitOut(repo, ["diff", "--name-only", "--diff-filter=U"])).toBe("1.txt");
    const text = await readFile(path.join(repo, "1.txt"), "utf8");
    expect(text).toContain("<<<<<<<");
    expect(text).toContain("mine");
    // Everything but the conflict is unstaged, as without local changes.
    expect(await gitOut(repo, ["diff", "--cached", "--name-only"])).toBe("1.txt");
    expect(summaryLines(seen[0]!).join("\n")).toContain("resolve the conflicts in 1.txt");

    await drop(seen[0]!);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("M 1.txt");
    expect(await gitOut(repo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await readFile(path.join(repo, "1.txt"), "utf8")).toBe("mine\n");
  });

  it("leaves a conflict with a commit made on the branch during the run as a merge conflict", async () => {
    // The user commits a conflicting 1.txt on main while the run is going.
    const provider = onReview(createFakeProvider(), async () => {
      await writeFile(path.join(repo, "1.txt"), "the user's own 1.txt\n");
      await gitOut(repo, ["add", "1.txt"]);
      await gitOut(repo, ["commit", "-q", "-m", "user change"]);
    });
    const events = new RunEmitter();
    const seen = ends(events);
    await runDiamond(provider, undefined, { events });
    expect(seen[0]!.merge).toMatchObject({ ok: true, conflicts: ["1.txt"] });
    expect(seen[0]!.merge!.backup).toBeUndefined();
    expect(await gitOut(repo, ["diff", "--name-only", "--diff-filter=U"])).toBe("1.txt");
    expect(await readFile(path.join(repo, "1.txt"), "utf8")).toContain("the user's own 1.txt");

    await drop(seen[0]!);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(repo, "1.txt"), "utf8")).toBe("the user's own 1.txt\n");
  });

  it("puts the checkout back when the branch moved with a conflict and there were local changes too", async () => {
    const provider = onReview(createFakeProvider(), async () => {
      await writeFile(path.join(repo, "1.txt"), "the user's own 1.txt\n");
      await gitOut(repo, ["add", "1.txt"]);
      await gitOut(repo, ["commit", "-q", "-m", "user change"]);
      await writeFile(path.join(repo, "README.md"), "# edited\n");
      await gitOut(repo, ["add", "README.md"]);
    });
    const events = new RunEmitter();
    const seen = ends(events);
    await runDiamond(provider, undefined, { events });
    expect(seen[0]!.merge).toMatchObject({ ok: false, reason: expect.stringContaining("conflicts with commits made on main") });
    // Exactly as before the apply, staging included.
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("M  README.md");
    expect(await readFile(path.join(repo, "1.txt"), "utf8")).toBe("the user's own 1.txt\n");
  });

  it("does not let git overwrite an untracked file of the user's", async () => {
    await writeFile(path.join(repo, "2.txt"), "mine\n");
    const events = new RunEmitter();
    const seen = ends(events);
    await runDiamond(createFakeProvider(), undefined, { events });
    expect(await readFile(path.join(repo, "2.txt"), "utf8")).toBe("mine\n");
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("?? 2.txt");
    expect(seen[0]!.merge).toMatchObject({ ok: false, reason: expect.stringContaining("rolled back") });
  });

  it("does not apply a result whose code review was not performed", async () => {
    const provider = createFakeProvider(
      fakeScriptSchema.parse({ "reviewer:code-r0": { attempts: [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }] } }),
    );
    const events = new RunEmitter();
    const seen = ends(events);
    const { result } = await runDiamond(provider, undefined, { events });
    expect(result.exitCode).toBe(4);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    expect(seen[0]!.merge).toMatchObject({ ok: false, reason: expect.stringContaining("code review was not performed") });
  });
});
