import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallError, installSkills } from "./skills.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const AGENTS = path.join(".agents", "skills");
const CLAUDE = path.join(".claude", "skills");
const TO_TASKS_FILES = ["SKILL.md", "validate-tasks.mjs"];

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "ge-install-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const files = (dir: string) => readdir(path.join(cwd, dir)).then((f) => f.sort());

describe("installSkills", () => {
  it("installs every bundled skill into .agents/skills by default", async () => {
    const { installed, skipped } = await installSkills({ target: "agents", force: false, cwd });
    expect(installed).toEqual([path.join(cwd, AGENTS, "run-graph"), path.join(cwd, AGENTS, "to-tasks")]);
    expect(skipped).toEqual([]);
    expect(await files(AGENTS)).toEqual(["run-graph", "to-tasks"]);
    expect(await files(path.join(AGENTS, "to-tasks"))).toEqual(TO_TASKS_FILES);
    expect(await files(path.join(AGENTS, "run-graph"))).toEqual(["SKILL.md"]);
    expect(existsSync(path.join(cwd, ".claude"))).toBe(false);
  });

  it("installs into .claude/skills with target claude", async () => {
    await installSkills({ target: "claude", force: false, cwd });
    expect(await files(CLAUDE)).toEqual(["run-graph", "to-tasks"]);
    expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
  });

  it("installs into both with target both", async () => {
    await installSkills({ target: "both", force: false, cwd });
    expect(await files(AGENTS)).toEqual(["run-graph", "to-tasks"]);
    expect(await files(CLAUDE)).toEqual(["run-graph", "to-tasks"]);
  });

  it("refuses a second run and changes nothing", async () => {
    await installSkills({ target: "agents", force: false, cwd });
    const skill = path.join(cwd, AGENTS, "to-tasks", "SKILL.md");
    await writeFile(skill, "edited");
    await expect(installSkills({ target: "agents", force: false, cwd })).rejects.toThrow(InstallError);
    expect(await readFile(skill, "utf8")).toBe("edited");
  });

  it("installs only the missing skill when another exists", async () => {
    await mkdir(path.join(cwd, AGENTS, "to-tasks"), { recursive: true });
    const { installed, skipped } = await installSkills({ target: "agents", force: false, cwd });
    expect(installed).toEqual([path.join(cwd, AGENTS, "run-graph")]);
    expect(skipped).toEqual([path.join(cwd, AGENTS, "to-tasks")]);
    expect(await files(path.join(AGENTS, "to-tasks"))).toEqual([]);
  });

  it("overwrites with force and removes stale files", async () => {
    await installSkills({ target: "agents", force: false, cwd });
    for (const skill of ["to-tasks", "run-graph"]) {
      await writeFile(path.join(cwd, AGENTS, skill, "SKILL.md"), "edited");
      await writeFile(path.join(cwd, AGENTS, skill, "stale.txt"), "old");
    }
    await installSkills({ target: "agents", force: true, cwd });
    expect(await files(path.join(AGENTS, "to-tasks"))).toEqual(TO_TASKS_FILES);
    expect(await files(path.join(AGENTS, "run-graph"))).toEqual(["SKILL.md"]);
    expect(await readFile(path.join(cwd, AGENTS, "run-graph", "SKILL.md"), "utf8")).toContain("name: run-graph");
  });

  it("installs what is missing and skips what exists", async () => {
    const existing = path.join(cwd, CLAUDE, "to-tasks");
    await mkdir(existing, { recursive: true });
    const { installed, skipped } = await installSkills({ target: "both", force: false, cwd });
    expect(installed.sort()).toEqual(
      [path.join(cwd, AGENTS, "run-graph"), path.join(cwd, AGENTS, "to-tasks"), path.join(cwd, CLAUDE, "run-graph")].sort(),
    );
    expect(skipped).toEqual([existing]);
    expect(await files(path.join(CLAUDE, "to-tasks"))).toEqual([]);
  });
});

describe("the bundled skill", () => {
  it("has no HITL/AFK wording and points to the task folder and the validation script", async () => {
    const skill = await readFile(path.join(root, "skills", "to-tasks", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: to-tasks\ndescription: .+\n---/);
    expect(skill).not.toMatch(/HITL|AFK/);
    expect(skill).toContain(".agents/tasks/<id>.json");
    expect(skill).toContain("validate-tasks.mjs .agents/tasks");
  });

  it("run-graph skill has the frontmatter, --web, exit codes and the no-polling rule", async () => {
    const skill = await readFile(path.join(root, "skills", "run-graph", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: run-graph\ndescription: Start a graph-execution run.+\n---/);
    expect(skill).toContain("--web");
    expect(skill).toMatch(/\*\*3\*\*/);
    expect(skill).toMatch(/\*\*2\*\*/);
    expect(skill).toContain("Do not sleep, poll");
    expect(skill).toContain("graph-execution open");
  });

  it("validation script imports only node: builtins", async () => {
    const script = await readFile(path.join(root, "skills", "to-tasks", "validate-tasks.mjs"), "utf8");
    const imports = [...script.matchAll(/(?:import\s[^"']*|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^node:/);
    expect(script).not.toMatch(/\brequire\(/);
  });
});

describe("graph-execution install skills (CLI)", () => {
  // vitest.global-setup.ts builds dist/ before the suite.
  const cli = path.join(root, "dist", "cli.js");
  const run = (args: string[]) => execa("node", [cli, "install", "skills", ...args], { cwd, reject: false });

  it("installs, refuses a second run with exit 2, and overwrites with --force", async () => {
    const first = await run([]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.split("\n")).toHaveLength(2);
    expect(first.stdout).toMatch(/Installed to-tasks skill into .*\.agents.skills.to-tasks/);
    expect(first.stdout).toMatch(/Installed run-graph skill into .*\.agents.skills.run-graph/);

    const second = await run([]);
    expect(second.exitCode).toBe(2);
    expect(second.stderr).toContain("already exists");

    expect((await run(["--force"])).exitCode).toBe(0);
  });

  it("reports a skipped skill with exit 0 when another was installed", async () => {
    await mkdir(path.join(cwd, AGENTS, "to-tasks"), { recursive: true });
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Installed run-graph skill");
    expect(result.stdout).toMatch(/Skipped to-tasks: .* already exists \(use --force to overwrite\)/);
  });

  it("installs both targets and rejects an unknown target with exit 2", async () => {
    expect((await run(["--target", "both"])).exitCode).toBe(0);
    expect(await files(CLAUDE)).toEqual(["run-graph", "to-tasks"]);
    const bad = await run(["--target", "nope"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("agents, claude, both");
  });
});
