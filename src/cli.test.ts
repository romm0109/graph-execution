import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "./__fixtures__/repo.js";
import { FAKE_PID_FILE } from "./providers/fake.js";
import { findOnPath } from "./providers/index.js";

// Runs the built entry; vitest.global-setup.ts builds dist/ before the suite.
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const fixture = (name: string): string => path.join(root, "src", "__fixtures__", name);
const spec = fixture("spec.md");

const run = (args: string[], cwd = root, env: Record<string, string> = {}) =>
  execa("node", [cli, ...args], { cwd, env, reject: false });

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await tempRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("graph-execution CLI", () => {
  it("prints the layers of a valid graph, runs it with the fake provider and exits 0", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("1 | 2 3 | 4");
      expect(res.stdout).toContain("1. 1");
      expect(res.stdout).toContain("2. 2 3");
      expect(res.stdout).toContain("3. 4");
      const runId = /Run (\S+):/.exec(res.stdout)?.[1];
      expect(runId).toBeDefined();
      expect((await gitOut(repo, ["ls-tree", "--name-only", `graph/${runId}`])).split("\n")).toEqual(
        expect.arrayContaining(["1.txt", "2.txt", "3.txt", "4.txt"]),
      );
      // The result is left on main as uncommitted changes, nothing committed.
      await gitOut(repo, ["add", "-A"]);
      expect(await gitOut(repo, ["diff", "--cached", "--name-only", `graph/${runId}`])).toBe("");
      expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      expect(res.stdout).toContain("as uncommitted changes");
    }));

  it("exits 2 when a scripted task makes no commit three times", () =>
    withRepo(async (repo) => {
      const script = path.join(repo, ".git", "fake-script.json");
      await writeFile(
        script,
        JSON.stringify({
          "task:1": {
            attempts: [{ commit: false }, { commit: false }, { commit: false }],
          },
        }),
      );
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo, {
        GRAPH_EXECUTION_FAKE_SCRIPT: script,
      });
      expect(res.exitCode).toBe(2);
      expect(res.stdout).toContain("aborted at task 1");
      expect(res.stdout).toMatch(/to resume: graph-execution --resume --run \d{8}-\d{6}-[0-9a-f]{4}/);
    }));

  it("exits 2 with a clear error for an unknown config key, before creating a run", () =>
    withRepo(async (repo) => {
      await writeFile(path.join(repo, "graph-execution.config.json"), JSON.stringify({ setpu: ["npm ci"] }));
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("graph-execution.config.json");
      expect(res.stderr).toContain("setpu");
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("on SIGINT kills the running agent, keeps the worktree and exits 2", () =>
    withRepo(async (repo) => {
      const script = path.join(repo, ".git", "fake-script.json");
      await writeFile(script, JSON.stringify({ "task:1": { attempts: [{ hang: true }] } }));
      const child = execa("node", [cli, fixture("diamond"), "--spec", spec, "--provider", "fake"], {
        cwd: repo,
        env: { GRAPH_EXECUTION_FAKE_SCRIPT: script },
        reject: false,
      });
      const runsDir = path.join(repo, ".graph-execution");
      let pidFile: string | undefined;
      while (!pidFile) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const runIds = await readdir(runsDir).catch(() => []);
        const candidate = runIds[0] && path.join(runsDir, runIds[0], "worktrees", "task-1-a1", FAKE_PID_FILE);
        if (candidate && existsSync(candidate)) pidFile = candidate;
      }
      const agentPid = Number(await readFile(pidFile, "utf8"));
      child.kill("SIGINT");
      const res = await child;

      expect(res.exitCode).toBe(2);
      expect(res.stdout).toContain("aborted at task 1: task 1 was interrupted");
      expect(res.stdout).toContain("to resume: graph-execution --resume --run");
      expect(() => process.kill(agentPid, 0)).toThrow();
      expect(existsSync(path.dirname(pidFile))).toBe(true);
      const state = JSON.parse(
        await readFile(path.join(path.dirname(path.dirname(path.dirname(pidFile))), "state.json"), "utf8"),
      );
      expect(state.tasks["1"]).toMatchObject({
        status: "running",
        attempts: 1,
      });
    }));

  it("exits 2 outside a git repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graph-execution-"));
    try {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], dir);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("not inside a git repository");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("reports a cycle and exits 2", async () => {
    const res = await run([fixture("cycle"), "--spec", spec, "--provider", "fake"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("a -> b -> a");
  });

  it("reports duplicate id, unknown and self dependency in one run", async () => {
    const res = await run([fixture("invalid-mix"), "--spec", spec, "--provider", "fake"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('duplicate task id "2"');
    expect(res.stderr).toContain('task "1" depends on itself');
    expect(res.stderr).toContain('task "2" depends on unknown task "missing"');
  });

  it("exits 2 for invalid JSON and an empty folder", async () => {
    const bad = await run([fixture("bad-json"), "--spec", spec, "--provider", "fake"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("invalid JSON");
    const empty = await run([fixture("empty"), "--spec", spec, "--provider", "fake"]);
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain("no task files found");
  });

  it("exits 2 when the spec is missing", async () => {
    const res = await run([fixture("diamond"), "--spec", fixture("nope.md"), "--provider", "fake"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("spec file not found");
  });

  it("exits 2 when the spec is empty", async () => {
    const res = await run([fixture("diamond"), "--spec", fixture("spec-empty.md"), "--provider", "fake"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("spec file is empty");
  });

  it.skipIf(process.getuid?.() === 0)("exits 2 when the spec is unreadable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graph-execution-"));
    const file = path.join(dir, "spec.md");
    try {
      await writeFile(file, "# spec");
      await chmod(file, 0o000);
      const res = await run([fixture("diamond"), "--spec", file, "--provider", "fake"]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("not readable");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("exits 2 when --spec is omitted", async () => {
    const res = await run([fixture("diamond"), "--provider", "fake"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--spec");
  });

  it("exits 2 for an unknown provider", async () => {
    const res = await run([fixture("diamond"), "--spec", spec, "--provider", "nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("claude, codex, opencode");
  });

  it("exits 2 at startup when --provider claude is not on the PATH", () =>
    withRepo(async (repo) => {
      // Only node's and git's directories, so no `claude` can be found.
      const git = findOnPath("git", repo)!;
      const PATH = [path.dirname(process.execPath), path.dirname(git)].join(path.delimiter);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "claude"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"claude" CLI was not found on the PATH');
    }));

  it("exits 2 at startup when --provider codex is not on the PATH", () =>
    withRepo(async (repo) => {
      const git = findOnPath("git", repo)!;
      const PATH = [path.dirname(process.execPath), path.dirname(git)].join(path.delimiter);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "codex"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"codex" CLI was not found on the PATH');
    }));

  it("runs the diamond graph end to end through the codex adapter with a fake codex", () =>
    withRepo(async (repo) => {
      // Fake `codex`: writes a file named after the task's first prompt line and commits it, or an empty report for the reviewer named by the report file.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
      try {
        const fake = path.join(bin, "codex");
        await writeFile(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv[0] !== "exec" || !argv.includes("--dangerously-bypass-approvals-and-sandbox")) process.exit(9);
const report = /absolute path: \`([^\`]+)\`/.exec(argv.at(-1));
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: require("path").basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = argv.at(-1).split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "codex: " + name]);
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "wrote " + name } }));
`,
        );
        await chmod(fake, 0o755);
        const res = await run([fixture("diamond"), "--spec", spec, "--provider", "codex"], repo, {
          PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
        });
        expect(res.exitCode, res.stdout + res.stderr).toBe(0);
        expect(res.stdout).toContain("wrote Set-up-the-base-.txt");
        const runId = /Run (\S+):/.exec(res.stdout)?.[1];
        expect((await gitOut(repo, ["ls-tree", "--name-only", `graph/${runId}`])).split("\n")).toEqual(
          expect.arrayContaining([
            "Set-up-the-base-.txt",
            "Build-feature-A-.txt",
            "Build-feature-B-.txt",
            "Integrate-A-and-B-.txt",
          ]),
        );
      } finally {
        await rm(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }));

  it("exits 2 at startup when --provider opencode is not on the PATH", () =>
    withRepo(async (repo) => {
      const git = findOnPath("git", repo)!;
      const PATH = [path.dirname(process.execPath), path.dirname(git)].join(path.delimiter);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "opencode"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"opencode" CLI was not found on the PATH');
    }));

  it("runs the diamond graph end to end through the opencode adapter with a fake opencode", () =>
    withRepo(async (repo) => {
      // Fake `opencode`: writes a file named after the task's first prompt line and commits it, or an empty report for the reviewer named by the report file.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
      try {
        const fake = path.join(bin, "opencode");
        await writeFile(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv[0] !== "run" || !argv.includes("--auto")) process.exit(9);
const report = /absolute path: \`([^\`]+)\`/.exec(argv.at(-1));
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: require("path").basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = argv.at(-1).split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "opencode: " + name]);
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "wrote " + name } }));
`,
        );
        await chmod(fake, 0o755);
        const res = await run([fixture("diamond"), "--spec", spec, "--provider", "opencode"], repo, {
          PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
        });
        expect(res.exitCode, res.stdout + res.stderr).toBe(0);
        expect(res.stdout).toContain("wrote Set-up-the-base-.txt");
        const runId = /Run (\S+):/.exec(res.stdout)?.[1];
        expect((await gitOut(repo, ["ls-tree", "--name-only", `graph/${runId}`])).split("\n")).toEqual(
          expect.arrayContaining([
            "Set-up-the-base-.txt",
            "Build-feature-A-.txt",
            "Build-feature-B-.txt",
            "Integrate-A-and-B-.txt",
          ]),
        );
      } finally {
        await rm(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }));

  it("accepts --resume without --spec and exits 2 when the run does not exist", () =>
    withRepo(async (repo) => {
      const res = await run(["--resume", "--run", "abc"], repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("no run abc to resume");
    }));
});
