import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveSpecToDone, moveSpecToDoneGit } from "./specdone.js";

let root: string;
let ws: string;

const git = (...args: string[]) => execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: ws });
const status = async (): Promise<string> => (await git("status", "--porcelain")).stdout;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "specdone-"));
  ws = path.join(root, "ws");
  await mkdir(path.join(ws, "docs", "prd"), { recursive: true });
  await git("init", "-q", "-b", "main");
  await writeFile(path.join(ws, "README.md"), "hi\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("moveSpecToDone", () => {
  it("moves a tracked spec with git mv (a staged rename)", async () => {
    await writeFile(path.join(ws, "docs/prd/x.md"), "# X\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "spec");
    expect(await moveSpecToDone(ws, path.join(ws, "docs/prd/x.md"))).toBe("docs/prd/done/x.md");
    expect(await status()).toContain("R  docs/prd/x.md -> docs/prd/done/x.md");
    expect(existsSync(path.join(ws, "docs/prd/x.md"))).toBe(false);
  });

  it("renames an untracked spec", async () => {
    await writeFile(path.join(ws, "docs/prd/y.md"), "# Y\n");
    expect(await moveSpecToDone(ws, "docs/prd/y.md")).toBe("docs/prd/done/y.md");
    expect(await readFile(path.join(ws, "docs/prd/done/y.md"), "utf8")).toBe("# Y\n");
    expect(existsSync(path.join(ws, "docs/prd/y.md"))).toBe(false);
  });

  it("leaves alone specs outside the workspace, under .graph-execution/, already in done/, missing, or with a taken destination", async () => {
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "# O\n");
    const runSpec = path.join(ws, ".graph-execution", "r1", "spec.md");
    await mkdir(path.dirname(runSpec), { recursive: true });
    await writeFile(runSpec, "# R\n");
    const inDone = path.join(ws, "docs/prd/done/z.md");
    await mkdir(path.dirname(inDone), { recursive: true });
    await writeFile(inDone, "# Z\n");
    const taken = path.join(ws, "docs/prd/z.md");
    await writeFile(taken, "# Z2\n");
    const before = await status();

    expect(await moveSpecToDone(ws, outside)).toBeUndefined();
    expect(await moveSpecToDone(ws, runSpec)).toBeUndefined();
    expect(await moveSpecToDone(ws, inDone)).toBeUndefined();
    expect(await moveSpecToDone(ws, path.join(ws, "docs/prd/missing.md"))).toBeUndefined();
    expect(await moveSpecToDone(ws, taken)).toBeUndefined();
    expect(await moveSpecToDone(ws, undefined)).toBeUndefined();

    expect(await status()).toBe(before);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(path.join(root, "done"))).toBe(false);
    expect(existsSync(runSpec)).toBe(true);
    expect(existsSync(path.join(ws, ".graph-execution", "r1", "done"))).toBe(false);
    expect(await readFile(taken, "utf8")).toBe("# Z2\n");
    expect(await readFile(inDone, "utf8")).toBe("# Z\n");
  });
});

describe("moveSpecToDoneGit", () => {
  const run = async (args: string[]) => {
    const res = await execa("git", args, { cwd: ws, reject: false });
    return { exitCode: res.exitCode ?? -1, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
  };

  it("moves a tracked spec as a staged rename", async () => {
    await writeFile(path.join(ws, "docs/prd/x.md"), "# X\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "spec");
    expect(await moveSpecToDoneGit(run, "docs/prd/x.md")).toBe("docs/prd/done/x.md");
    expect(await status()).toContain("R  docs/prd/x.md -> docs/prd/done/x.md");
    expect(existsSync(path.join(ws, "docs/prd/x.md"))).toBe(false);
    expect(await readFile(path.join(ws, "docs/prd/done/x.md"), "utf8")).toBe("# X\n");
  });

  it("moves an untracked spec, staged as a new file", async () => {
    await writeFile(path.join(ws, "docs/prd/y.md"), "# Y\n");
    expect(await moveSpecToDoneGit(run, "docs/prd/y.md")).toBe("docs/prd/done/y.md");
    expect(await status()).toContain("A  docs/prd/done/y.md");
    expect(existsSync(path.join(ws, "docs/prd/y.md"))).toBe(false);
  });

  it("leaves a spec alone when missing, in done/, under .graph-execution, outside, or the destination exists", async () => {
    expect(await moveSpecToDoneGit(run, undefined)).toBeUndefined();
    expect(await moveSpecToDoneGit(run, "docs/prd/missing.md")).toBeUndefined();
    expect(await moveSpecToDoneGit(run, "docs/prd/done/a.md")).toBeUndefined();
    expect(await moveSpecToDoneGit(run, ".graph-execution/r/spec.md")).toBeUndefined();
    expect(await moveSpecToDoneGit(run, "../x.md")).toBeUndefined();
    await mkdir(path.join(ws, "docs/prd/done"), { recursive: true });
    await writeFile(path.join(ws, "docs/prd/z.md"), "# Z\n");
    await writeFile(path.join(ws, "docs/prd/done/z.md"), "# old Z\n");
    expect(await moveSpecToDoneGit(run, "docs/prd/z.md")).toBeUndefined();
    expect(existsSync(path.join(ws, "docs/prd/z.md"))).toBe(true);
  });
});
