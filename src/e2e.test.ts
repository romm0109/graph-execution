import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "./__fixtures__/repo.js";
import { FAKE_SCRIPT_ENV } from "./providers/fake.js";

// Packs the package built by vitest.global-setup.ts and runs the packed bin, as `npx` would.
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string): string => path.join(root, "src", "__fixtures__", name);
const spec = fixture("spec.md");
/** A whole run through the packed bin; generous because the full suite runs many repos in parallel. */
const RUN_TIMEOUT = 60_000;

let packDir: string;
let tarball: string;
let bin: string;

beforeAll(async () => {
  packDir = await mkdtemp(path.join(tmpdir(), "graph-execution-pack-"));
  const { stdout } = await execa("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], { cwd: root });
  tarball = path.join(packDir, (JSON.parse(stdout) as { filename: string }[])[0]!.filename);
  await execa("tar", ["-xzf", tarball], { cwd: packDir });
  // The tarball has no dependencies; the repo's node_modules stands in for `npm install`.
  await symlink(path.join(root, "node_modules"), path.join(packDir, "package", "node_modules"), "dir");
  bin = path.join(packDir, "package", "dist", "cli.js");
}, 60_000);

afterAll(async () => {
  await rm(packDir, { recursive: true, force: true });
});

const blocker = {
  id: "F1",
  severity: "blocker",
  file: "1.txt",
  line: 1,
  description: "Wrong content.",
  failureScenario: "Reading 1.txt returns the task id instead of the result.",
  status: "open",
};

/** Runs the packed CLI on the diamond in a fresh repo with the fake provider following `script`. */
async function runPacked(script: unknown, fn: (repo: string, res: { exitCode?: number; stdout: string }) => Promise<void>) {
  const repo = await tempRepo();
  try {
    const scriptFile = path.join(repo, ".git", "fake-script.json");
    await writeFile(scriptFile, JSON.stringify(script));
    const res = await execa(bin, [fixture("diamond"), "--spec", spec, "--provider", "fake"], {
      cwd: repo,
      env: { [FAKE_SCRIPT_ENV]: scriptFile },
      reject: false,
    });
    await fn(repo, res);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function onlyRun(repo: string): Promise<{ runId: string; runDir: string }> {
  const runs = await readdir(path.join(repo, ".graph-execution"));
  expect(runs).toHaveLength(1);
  return { runId: runs[0]!, runDir: path.join(repo, ".graph-execution", runs[0]!) };
}

describe("packed package", () => {
  it("contains only dist/, skills/, README.md and package.json, with an executable bin", async () => {
    const { stdout } = await execa("tar", ["-tzf", tarball]);
    const tops = new Set(stdout.split("\n").filter(Boolean).map((f) => f.replace(/^package\//, "").split("/")[0]));
    for (const top of tops) expect(["dist", "skills", "README.md", "package.json"]).toContain(top);
    expect(tops).toContain("dist");
    expect(tops).toContain("README.md");
    expect((await readFile(bin, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    const help = await execa(bin, ["--help"], { reject: false });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("graph-execution");
    expect(help.stdout).toContain("--spec");
  }, RUN_TIMEOUT);

  it("runs tasks, finds a seeded blocker, fixes it and exits 0 leaving only the branch and the run directory", () =>
    runPacked(
      {
        "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
        "reviewer:code-r1": { attempts: [{ report: { findings: [{ ...blocker, status: "fixed" }] } }] },
      },
      async (repo, res) => {
        const before = await gitOut(repo, ["rev-parse", "HEAD"]);
        expect(res.exitCode, res.stdout).toBe(0);
        const { runId, runDir } = await onlyRun(repo);
        const branch = `graph/${runId}`;

        // The fixer's commit is the tip of the branch, on top of the four task merges.
        expect(await gitOut(repo, ["log", "-1", "--format=%s", branch])).toBe("fake: fixer:fix-r1 attempt 1");
        expect(await gitOut(repo, ["rev-list", "--count", "--merges", branch])).toBe("4");

        // No worktree is left, neither registered with git nor on disk.
        expect((await gitOut(repo, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(1);
        expect(existsSync(path.join(runDir, "worktrees"))).toBe(false);
        expect((await readdir(runDir)).sort()).toEqual(expect.arrayContaining(["logs", "reports", "state.json"]));
        expect(existsSync(path.join(runDir, "reports", "round1"))).toBe(true);

        // The user's branch is untouched.
        expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
        expect(await gitOut(repo, ["rev-parse", "HEAD"])).toBe(before);
        expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
      },
    ), RUN_TIMEOUT);

  it("exits 1 when the review never comes back clean, keeping branch, worktrees and reports", () =>
    runPacked(
      Object.fromEntries(
        [0, 1, 2, 3].map((r) => [
          `reviewer:code-r${r}`,
          { attempts: [{ report: { findings: [{ ...blocker, status: r === 0 ? "open" : "not_fixed" }] } }] },
        ]),
      ),
      async (repo, res) => {
        expect(res.exitCode, res.stdout).toBe(1);
        const { runId, runDir } = await onlyRun(repo);
        expect(await gitOut(repo, ["branch", "--list", `graph/${runId}`])).toContain(`graph/${runId}`);
        const integration = path.join(runDir, "worktrees", "integration");
        expect(existsSync(integration)).toBe(true);
        expect(await gitOut(repo, ["worktree", "list"])).toContain(integration);
        for (const round of [0, 1, 2, 3]) expect(existsSync(path.join(runDir, "reports", `round${round}`))).toBe(true);
        expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      },
    ), RUN_TIMEOUT);
});

describe("exit codes", () => {
  it("are set only by cli.ts, through setExitCode", async () => {
    const sources = (await readdir(path.join(root, "src"), { recursive: true }))
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith("__fixtures__"));
    const offenders: string[] = [];
    for (const file of sources) {
      const text = await readFile(path.join(root, "src", file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (!/process\.exit(Code)?\b/.test(line)) continue;
        // In cli.ts only the body of setExitCode may touch the exit code.
        if (file === "cli.ts" && /^\s*(if \(immediately\) process\.exit\(code\);|process\.exitCode = code;)/.test(line)) continue;
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
        offenders.push(`src/${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
