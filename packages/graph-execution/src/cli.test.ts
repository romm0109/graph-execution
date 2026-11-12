import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { writeFakeBin } from "./__fixtures__/fake-bin.js";
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

/** Runs the CLI with human review and answers the pause with Apply on the in-process web server. */
async function runReviewed(args: string[], cwd: string, action = "apply") {
  const child = execa("node", [cli, ...args], { cwd, reject: false });
  let out = "";
  let posted = false;
  child.stdout?.on("data", async (chunk: Buffer) => {
    out += chunk.toString();
    const url = /waiting for your review: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1];
    if (!url || posted) return;
    posted = true;
    const origin = url.replace(/\/$/, "");
    await fetch(`${url}review/${action}`, { method: "POST", headers: { origin } });
  });
  return child;
}

/**
 * A PATH on which only `node` and `git` can be found, so no provider CLI is. Their own directories are not enough: a
 * provider installed globally with npm sits next to `node`. POSIX gets a folder of symlinks; Windows, where symlinks
 * need extra rights, falls back to the two directories.
 */
async function onlyNodeAndGit(repo: string): Promise<string> {
  const git = findOnPath("git", repo)!;
  if (process.platform === "win32") return [path.dirname(process.execPath), path.dirname(git)].join(path.delimiter);
  const bin = await mkdtemp(path.join(repo, ".bin-"));
  await symlink(process.execPath, path.join(bin, "node"));
  await symlink(git, path.join(bin, "git"));
  return bin;
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await tempRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("graph-execution CLI", () => {
  it("lists in RUN_VALUE_OPTIONS every run option that takes a value (KAN-88 F6)", async () => {
    const { RUN_VALUE_OPTIONS } = await import("./state/paths.js");
    const res = await run(["--help"]);
    const options = res.stdout.split("Commands:")[0] ?? "";
    const valued = [...options.matchAll(/(--[a-z][a-z-]*) [<[]/g)].map((m) => m[1]);
    expect(valued.length).toBeGreaterThan(0);
    expect([...valued].sort()).toEqual([...RUN_VALUE_OPTIONS].sort());
  });

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
            attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }],
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

  it("exits 2 for a missing --reviewers file, before creating a run", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--reviewers", "nope.json"], repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("reviewers file not found");
      expect(res.stderr).toContain("nope.json");
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  // Windows has no SIGINT one process can send another: child.kill("SIGINT") terminates it without running handlers.
  it.skipIf(process.platform === "win32")("on SIGINT kills the running agent, keeps the worktree and exits 2", () =>
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

  /** Starts a run whose task 1 hangs, waits for its agent, SIGKILLs the CLI and returns the orphaned agent. */
  async function killedRun(repo: string): Promise<{ script: string; runDir: string; agentPid: number }> {
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
    const runDir = path.dirname(path.dirname(path.dirname(pidFile)));
    // The CLI writes the record right after the spawn, but on macOS only after a synchronous `ps` for the start time,
    // so the agent's own pid file can appear first: wait for the record before killing the CLI.
    const record = path.join(runDir, "pids", `${agentPid}.json`);
    for (const until = Date.now() + 5000; !existsSync(record) && Date.now() < until; ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(record)).toBe(true);
    child.kill("SIGKILL");
    await child;
    expect(() => process.kill(agentPid, 0)).not.toThrow();
    return { script, runDir, agentPid };
  }

  /** Polls until `pid` is gone; a zombie (reparented to PID 1, not yet reaped) counts as gone. */
  async function gone(pid: number): Promise<boolean> {
    for (const until = Date.now() + 5000; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
      try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
          if (stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return true;
        }
      } catch {
        return true;
      }
      if (Date.now() > until) return false;
    }
  }

  const killQuietly = (pid: number | undefined): void => {
    try {
      if (pid !== undefined) process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
  };

  it.skipIf(process.platform === "win32")("after a SIGKILL, --resume stops the agent the killed run left running", () =>
    withRepo(async (repo) => {
      let agentPid: number | undefined;
      try {
        const killed = await killedRun(repo);
        agentPid = killed.agentPid;
        await writeFile(killed.script, "{}");
        const res = await run(["--resume"], repo, { GRAPH_EXECUTION_FAKE_SCRIPT: killed.script });
        expect(res.stdout).toContain(`stopped agent 1 (pid ${agentPid})`);
        expect(res.exitCode).toBe(0);
        expect(await gone(agentPid)).toBe(true);
        const left = (await readdir(path.join(killed.runDir, "pids")).catch(() => [])).filter((n) => n.endsWith(".json"));
        expect(left).toEqual([]);
      } finally {
        killQuietly(agentPid);
      }
    }));

  it.skipIf(process.platform === "win32")("after a SIGKILL, clean --yes stops the agent before deleting the run", () =>
    withRepo(async (repo) => {
      let agentPid: number | undefined;
      try {
        const killed = await killedRun(repo);
        agentPid = killed.agentPid;
        const res = await run(["clean", "--yes"], repo);
        expect(res.exitCode).toBe(0);
        expect(await gone(agentPid)).toBe(true);
        expect(existsSync(killed.runDir)).toBe(false);
      } finally {
        killQuietly(agentPid);
      }
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

  // On Windows chmod only sets the read-only flag: the file stays readable.
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")("exits 2 when the spec is unreadable", async () => {
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

  it("prints the package version for --version and -v and exits 0 (GE-18)", async () => {
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) {
      const res = await run([flag]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe(version);
    }
  });

  it("hands its arguments to graph-manager's engine in a graph-manager terminal", async () => {
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    const dir = await mkdtemp(path.join(tmpdir(), "ge-delegate-"));
    try {
      const delegate = path.join(dir, "d.js");
      await writeFile(
        delegate,
        "console.log('delegated ' + process.argv.slice(2).join(' ')); process.exitCode = process.env.GRAPH_EXECUTION_DELEGATED === '1' ? 7 : 3;",
      );
      // Another copy of the engine (npx, a global install): delegated.
      const other = await run(["--version"], root, { GRAPH_EXECUTION_DELEGATE: delegate, GM_ENGINE_BIN: path.join(dir, "other.js") });
      expect(other.stdout.trim()).toBe("delegated --version");
      expect(other.exitCode).toBe(7);
      // graph-manager's engine itself, an already delegated run, or no delegate: runs in place.
      const envs: Record<string, string>[] = [
        { GRAPH_EXECUTION_DELEGATE: delegate, GM_ENGINE_BIN: cli },
        { GRAPH_EXECUTION_DELEGATE: delegate, GM_ENGINE_BIN: path.join(dir, "other.js"), GRAPH_EXECUTION_DELEGATED: "1" },
        { GRAPH_EXECUTION_DELEGATE: path.join(dir, "missing.js"), GM_ENGINE_BIN: path.join(dir, "other.js") },
      ];
      for (const env of envs) {
        const res = await run(["--version"], root, env);
        expect(res.stdout.trim()).toBe(version);
        expect(res.exitCode).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 for an unknown provider", async () => {
    const res = await run([fixture("diamond"), "--spec", spec, "--provider", "nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("claude, codex, opencode, qwen");
  });

  it("exits 2 at startup when --provider claude is not on the PATH", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "claude"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"claude" CLI was not found on the PATH');
    }));

  it("exits 2 at startup when --provider codex is not on the PATH", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "codex"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"codex" CLI was not found on the PATH');
    }));

  it("exits 2 at startup when a reviewer's provider is not on the PATH, before creating the run", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const file = path.join(repo, ".git", "reviewers.json");
      const security = { id: "security", type: "diff", name: "Security", repoFile: "SECURITY_REVIEW.md", provider: "codex" };
      await writeFile(file, JSON.stringify({ reviewers: [security] }));
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--reviewers", file], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('reviewer "security"');
      expect(res.stderr).toContain("codex");
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("runs the diamond graph end to end through the codex adapter with a fake codex", () =>
    withRepo(async (repo) => {
      // Fake `codex`: writes a file named after the task's first prompt line and commits it, or an empty report for the reviewer named by the report file.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
      try {
        const fake = path.join(bin, "codex");
        await writeFakeBin(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
if (argv[0] !== "exec" || !argv.includes("--dangerously-bypass-approvals-and-sandbox")) process.exit(9);
const report = /absolute path: \`([^\`]+)\`/.exec(prompt);
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: require("path").basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = prompt.split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "codex: " + name]);
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "wrote " + name } }));
`,
        );
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
      const PATH = await onlyNodeAndGit(repo);
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
        await writeFakeBin(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
if (argv[0] !== "run" || !argv.includes("--auto")) process.exit(9);
const report = /absolute path: \`([^\`]+)\`/.exec(prompt);
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: require("path").basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = prompt.split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "opencode: " + name]);
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "wrote " + name } }));
`,
        );
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

  it("exits 2 at startup when --provider qwen is not on the PATH", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "qwen"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"qwen" CLI was not found on the PATH');
    }));

  it("runs the diamond graph end to end through the qwen adapter with a fake qwen", () =>
    withRepo(async (repo) => {
      // Fake `qwen`: writes a file named after the task's first prompt line and commits it, or an empty report for the reviewer named by the report file.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
      try {
        const fake = path.join(bin, "qwen");
        await writeFakeBin(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
if (!argv.includes("--yolo") || !argv.includes("stream-json")) process.exit(9);
const report = /absolute path: \`([^\`]+)\`/.exec(prompt);
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: require("path").basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = prompt.split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "qwen: " + name]);
console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "wrote " + name }] } }));
`,
        );
        const res = await run([fixture("diamond"), "--spec", spec, "--provider", "qwen"], repo, {
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

  it("exits 2 at startup when --provider pi is not on the PATH", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "pi"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('the "pi" CLI was not found on the PATH; install it and log in before running');
    }));

  // Windows: onlyNodeAndGit gives the real node and git dirs, where no fake may be written.
  it.skipIf(process.platform === "win32")("exits 2 at startup when --provider omp is on the PATH but Bun is not", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const dir = PATH.split(path.delimiter)[0]!;
      await writeFakeBin(path.join(dir, "omp"), "#!/usr/bin/env node\n");
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "omp"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("needs Bun");
    }));

  it("runs the diamond graph end to end through the pi adapter with a fake pi", () =>
    withRepo(async (repo) => {
      // Fake `pi`: writes a file named after the task's first prompt line and commits it, or an empty report for the reviewer named by the report file.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
      try {
        const fake = path.join(bin, "pi");
        await writeFakeBin(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
if (argv.join(" ") !== "--mode json --no-session") process.exit(9);
const report = /absolute path: \`([^\`]+)\`/.exec(prompt);
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: require("path").basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = prompt.split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "pi: " + name]);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "wrote " + name }], stopReason: "stop" } }));
`,
        );
        const res = await run([fixture("diamond"), "--spec", spec, "--provider", "pi"], repo, {
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

  it("exits 2 at startup when --provider copilot is not on the PATH", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "copilot"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('"copilot" CLI was not found on the PATH');
    }));

  it("runs the diamond graph end to end through the copilot adapter with a fake copilot", () =>
    withRepo(async (repo) => {
      // Fake `copilot`: writes a file named after the task's first prompt line and commits it, or an empty report for the reviewer named by the report file.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
      const home = await mkdtemp(path.join(tmpdir(), "graph-execution-copilot-home-"));
      try {
        const fake = path.join(bin, "copilot");
        await writeFakeBin(
          fake,
          `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
if (argv.slice(0, 5).join(" ") !== "--output-format json --allow-all --no-auto-update --session-id" || argv.includes("-p")) process.exit(9);
if (process.env.COPILOT_AUTO_UPDATE !== "false") process.exit(8);
fs.mkdirSync(path.join(process.env.COPILOT_HOME, "session-state", argv[5]), { recursive: true });
const report = /absolute path: \`([^\`]+)\`/.exec(prompt);
if (report) {
  fs.writeFileSync(report[1], JSON.stringify({ round: 0, reviewer: path.basename(report[1], ".json"), findings: [] }));
  process.exit(0);
}
const name = prompt.split("\\n")[0].replace(/[^A-Za-z]+/g, "-") + ".txt";
fs.writeFileSync(name, "done\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-m", "copilot: " + name]);
console.log(JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "wrote " + name, toolRequests: [] } }));
`,
        );
        const res = await run([fixture("diamond"), "--spec", spec, "--provider", "copilot"], repo, {
          PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
          COPILOT_HOME: home,
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
        expect(await readdir(path.join(home, "session-state"))).toEqual([]);
      } finally {
        await rm(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }));

  it("saves the effective humanReview in state.json and rejects the flags on --resume", () =>
    withRepo(async (repo) => {
      const saved = async (res: { stdout: string }): Promise<boolean> => {
        const id = /Run (\S+):/.exec(res.stdout)![1]!;
        const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
        return state.humanReview;
      };
      const a = await runReviewed([fixture("diamond"), "--spec", spec, "--provider", "fake", "--human-review"], repo);
      expect(await saved(a)).toBe(true);
      await writeFile(path.join(repo, "graph-execution.config.json"), JSON.stringify({ humanReview: true }));
      const b = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--no-human-review"], repo);
      expect(await saved(b)).toBe(false);
      const r = await run(["--resume", "--human-review"], repo);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("--resume takes no --human-review or --no-human-review");
    }));

  it("runs with --fix-passes 0 --attempts 1, saves the overrides and leaves the config alone (KAN-89)", () =>
    withRepo(async (repo) => {
      const res = await run(
        [fixture("diamond"), "--spec", spec, "--provider", "fake", "--fix-passes", "0", "--attempts", "1"],
        repo,
      );
      expect(res.exitCode).toBe(0);
      const id = /Run (\S+):/.exec(res.stdout)![1]!;
      const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
      expect(state.overrides).toEqual({ fixPasses: 0, attempts: 1 });
      expect(existsSync(path.join(repo, "graph-execution.config.json"))).toBe(false);
    }));

  it("applies --attempts to the run and refuses it on --resume", () =>
    withRepo(async (repo) => {
      const script = path.join(repo, ".git", "fake-script.json");
      await writeFile(
        script,
        JSON.stringify({ "task:1": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }] } }),
      );
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--attempts", "1"], repo, {
        GRAPH_EXECUTION_FAKE_SCRIPT: script,
      });
      expect(res.exitCode).toBe(2);
      const id = /Run (\S+):/.exec(res.stdout)![1]!;
      const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
      expect(state.tasks["1"].attempts).toBe(1);
      const r = await run(["--resume", "--attempts", "2"], repo);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("cannot change --attempts on --resume: the run keeps the options it started with");
    }));

  it("saves --review-provider and --review-model in state.json and refuses them on --resume", () =>
    withRepo(async (repo) => {
      const res = await run(
        [fixture("diamond"), "--spec", spec, "--provider", "fake", "--review-provider", "fake", "--review-model", "m"],
        repo,
      );
      expect(res.exitCode).toBe(0);
      const id = /Run (\S+):/.exec(res.stdout)![1]!;
      const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
      expect(state).toMatchObject({ reviewProvider: "fake", reviewModel: "m" });
      expect(existsSync(path.join(repo, ".graph-execution", id, "reviewers.json"))).toBe(false);
      const a = await run(["--resume", "--review-provider", "claude"], repo);
      expect(a.exitCode).toBe(2);
      expect(a.stderr).toContain("--review-provider cannot be used with --resume; the run keeps the review provider it started with");
      const b = await run(["--resume", "--review-model", "x"], repo);
      expect(b.exitCode).toBe(2);
      expect(b.stderr).toContain("--review-model cannot be used with --resume; the run keeps the review model it started with");
    }));

  it("exits 2 for an unknown --review-provider, listing the providers", async () => {
    const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--review-provider", "nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("claude, codex, opencode, qwen");
  });

  it("exits 2 at startup when the review provider is not on the PATH, before creating the run", () =>
    withRepo(async (repo) => {
      const PATH = await onlyNodeAndGit(repo);
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--review-provider", "codex"], repo, { PATH });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('review provider "codex"');
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("rejects a bad --validate-at before creating a run", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--validate-at", "sometimes"], repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("--validate-at");
      expect(res.stderr).toContain("must be task or end");
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("rejects a negative --idle-timeout", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--idle-timeout", "-1"], repo);
      expect(res.exitCode).toBe(2);
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("serves the human review next to the terminal view and ends on Apply", () =>
    withRepo(async (repo) => {
      const res = await runReviewed([fixture("diamond"), "--spec", spec, "--provider", "fake", "--human-review"], repo);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("web view: http://127.0.0.1:");
      expect(res.stdout).toContain("waiting for your review:");
      expect(existsSync(path.join(repo, "4.txt"))).toBe(true);
    }));

  it("starts no web server without human review", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--no-human-review"], repo);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("web view:");
      expect(res.stdout).not.toContain("waiting for your review");
    }));

  it("refuses --sandbox without docker before creating a run", () =>
    withRepo(async (repo) => {
      const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--sandbox"], repo, {
        PATH: await onlyNodeAndGit(repo),
      });
      expect(res.exitCode).toBe(2);
      // Windows refuses the sandbox before looking for Docker.
      expect(res.stderr).toContain(
        process.platform === "win32" ? "error: the sandbox needs Linux or macOS; on Windows use WSL" : "error: --sandbox needs Docker",
      );
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("refuses the --sandbox-* flags without --sandbox, and suites with --sandbox", () =>
    withRepo(async (repo) => {
      const flags = await run([fixture("diamond"), "--spec", spec, "--provider", "fake", "--sandbox-line", "RUN echo hi"], repo);
      expect(flags.exitCode).toBe(2);
      expect(flags.stderr).toContain("--sandbox-line needs --sandbox");
      const suite = await run(["suite", "--feature", `${fixture("diamond")}:${spec}`, "--provider", "fake", "--sandbox"], repo);
      expect(suite.exitCode).toBe(2);
      expect(suite.stderr).toContain("suites cannot run in a sandbox yet");
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("records the sandbox in state.json only when GRAPH_EXECUTION_SANDBOX=1 (KAN-88)", () =>
    withRepo(async (repo) => {
      const state = async (res: { stdout: string }) => {
        const id = /Run (\S+):/.exec(res.stdout)![1]!;
        return JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
      };
      const a = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo, {
        GRAPH_EXECUTION_SANDBOX: "1",
        GRAPH_EXECUTION_SANDBOX_IMAGE: "node:22-bookworm",
      });
      expect(a.exitCode).toBe(0);
      expect((await state(a)).sandbox).toEqual({ image: "node:22-bookworm" });
    }).then(() =>
      withRepo(async (repo) => {
        const b = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo);
        expect(b.exitCode).toBe(0);
        const id = /Run (\S+):/.exec(b.stdout)![1]!;
        const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
        expect(state).not.toHaveProperty("sandbox");
      }),
    ));

  it("resumes a sandboxed run only with GRAPH_EXECUTION_SANDBOX=1 (KAN-88)", () =>
    withRepo(async (repo) => {
      const script = path.join(repo, ".git", "fake-script.json");
      await writeFile(
        script,
        JSON.stringify({
          "task:1": {
            attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }],
          },
        }),
      );
      const first = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo, {
        GRAPH_EXECUTION_FAKE_SCRIPT: script,
        GRAPH_EXECUTION_SANDBOX: "1",
      });
      expect(first.exitCode).toBe(2);
      const id = /Run (\S+):/.exec(first.stdout)![1]!;
      const hint = `run ${id} ran in a sandbox: resume it with graph-execution --resume --run ${id} --sandbox, or from graph-manager`;

      const plain = await run(["--resume"], repo);
      expect(plain.exitCode).toBe(2);
      expect(plain.stderr).toContain(hint);

      const web = await run(["--resume", "--web"], repo, { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1" });
      expect(web.exitCode).toBe(2);
      expect(web.stderr).toContain(hint);
      expect(existsSync(path.join(repo, ".graph-execution", id, "web.json"))).toBe(false);

      const empty = path.join(repo, ".git", "empty-script.json");
      await writeFile(empty, "{}");
      const ok = await run(["--resume"], repo, { GRAPH_EXECUTION_SANDBOX: "1", GRAPH_EXECUTION_FAKE_SCRIPT: empty });
      expect(ok.stderr).not.toContain("ran in a sandbox");
      expect(ok.exitCode).toBe(0);
      const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", id, "state.json"), "utf8"));
      expect(state.sandbox).toEqual({ image: "" });
    }));

  it("accepts --resume without --spec and exits 2 when the run does not exist", () =>
    withRepo(async (repo) => {
      const res = await run(["--resume", "--run", "abc"], repo);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("no run abc to resume");
    }));

  it("exits 2 before starting any task when git has no identity", () =>
    withRepo(async (repo) => {
      const home = await mkdtemp(path.join(tmpdir(), "no-identity-home-"));
      try {
        await execa("git", ["config", "--unset", "user.name"], { cwd: repo });
        await execa("git", ["config", "--unset", "user.email"], { cwd: repo });
        await execa("git", ["config", "user.useConfigOnly", "true"], { cwd: repo });
        const res = await execa("node", [cli, fixture("diamond"), "--spec", spec, "--provider", "fake"], {
          cwd: repo,
          reject: false,
          env: {
            HOME: home,
            XDG_CONFIG_HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: undefined,
            GIT_AUTHOR_EMAIL: undefined,
            GIT_COMMITTER_NAME: undefined,
            GIT_COMMITTER_EMAIL: undefined,
            EMAIL: undefined,
          },
        });
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toContain("git has no commit identity");
        expect(res.stderr).toContain("git config --global user.name");
        expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
        expect(await gitOut(repo, ["for-each-ref", "refs/heads/graph", "refs/heads/graph-task"])).toBe("");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }));

  it("exits 2 at startup for a leftover worktree of a forced run id", () =>
    withRepo(async (repo) => {
      const rid = "20260101-000000-abcd";
      const outside = await mkdtemp(path.join(tmpdir(), "leftover-"));
      await rm(outside, { recursive: true });
      try {
        await execa("git", ["worktree", "add", "-q", "-b", `graph-task/${rid}/2`, outside], { cwd: repo });
        const res = await run([fixture("diamond"), "--spec", spec, "--provider", "fake"], repo, {
          GRAPH_EXECUTION_RUN_ID: rid,
        });
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toContain("cannot start");
        expect(res.stderr).toContain("git worktree remove --force");
        expect(existsSync(path.join(repo, ".graph-execution", rid, "state.json"))).toBe(false);
        expect(await gitOut(repo, ["for-each-ref", `refs/heads/graph/${rid}`])).toBe("");
        expect(existsSync(outside)).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }));

  describe("sandbox commands", () => {
    it("prints the Dockerfile and its tag with no docker on the PATH", () =>
      withRepo(async (repo) => {
        const res = await run(["sandbox", "dockerfile", "--provider", "pi"], repo, { PATH: await onlyNodeAndGit(repo) });
        expect(res.exitCode, res.stderr).toBe(0);
        expect(res.stdout).toMatch(/^FROM node:24\.22\.1-bookworm\n/);
        expect(res.stdout).toContain("npm install -g --no-audit --no-fund @mariozechner/pi-coding-agent\n");
        expect(res.stdout).toMatch(/# tag: graph-execution-sandbox:[0-9a-f]{12}/);
      }));

    it("edits only the sandbox section of the config and refuses FROM lines without writing", () =>
      withRepo(async (repo) => {
        const file = path.join(repo, "graph-execution.config.json");
        await writeFile(file, JSON.stringify({ validate: ["true"] }));
        const res = await run(["sandbox", "config", "--base", "node:22-bookworm", "--line", "RUN echo hi"], repo);
        expect(res.exitCode, res.stderr).toBe(0);
        const text = await readFile(file, "utf8");
        expect(JSON.parse(text)).toEqual({ validate: ["true"], sandbox: { base: "node:22-bookworm", dockerfile: ["RUN echo hi"] } });
        expect(text.endsWith("}\n")).toBe(true);
        expect(res.stdout).toContain('"base": "node:22-bookworm"');

        const bad = await run(["sandbox", "config", "--line", "FROM x"], repo);
        expect(bad.exitCode).toBe(2);
        expect(bad.stderr).toContain("FROM is not allowed");
        expect(await readFile(file, "utf8")).toBe(text);

        const both = await run(["sandbox", "config", "--image", "a", "--base", "b"], repo);
        expect(both.exitCode).toBe(2);
        expect(await readFile(file, "utf8")).toBe(text);
      }));

    it("exits 2 from sandbox build when there is no docker", () =>
      withRepo(async (repo) => {
        const res = await run(["sandbox", "build"], repo, { PATH: await onlyNodeAndGit(repo) });
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toContain("--sandbox needs Docker");
      }));

    it("builds through docker build -t <tag> - with the Dockerfile on stdin", () =>
      withRepo(async (repo) => {
        if (process.platform === "win32") return;
        const bin = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
        try {
          const log = path.join(bin, "calls.jsonl");
          await writeFakeBin(
            path.join(bin, "docker"),
            `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const stdin = argv[0] === "build" ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin }) + "\\n");
if (argv[0] === "image" && argv[1] === "inspect") process.exit(1);
if (argv[0] === "build") console.log("Step 1/5 : FROM node");
`,
          );
          const res = await run(["sandbox", "build", "--provider", "claude"], repo, {
            PATH: [bin, await onlyNodeAndGit(repo)].join(path.delimiter),
          });
          expect(res.exitCode, res.stderr).toBe(0);
          const calls = (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
          const build = calls.find((c) => c.argv[0] === "build")!;
          expect(build.argv).toEqual(["build", "-t", expect.stringMatching(/^graph-execution-sandbox:[0-9a-f]{12}$/), "-"]);
          expect(build.stdin).toContain("npm install -g --no-audit --no-fund @anthropic-ai/claude-code\n");
          expect(res.stdout).toContain("Step 1/5 : FROM node");
          expect(res.stdout).toContain(`Sandbox image: ${build.argv[2]}`);
        } finally {
          await rm(bin, { recursive: true, force: true });
        }
      }));
  });
});
