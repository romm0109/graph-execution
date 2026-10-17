import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallError, installSkills } from "./skills.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const AGENTS = path.join(".agents", "skills", "to-issues");
const CLAUDE = path.join(".claude", "skills", "to-issues");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "ge-install-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const files = (dir: string) => readdir(path.join(cwd, dir)).then((f) => f.sort());

describe("installSkills", () => {
  it("installs into .agents/skills/to-issues by default", async () => {
    const installed = await installSkills({ target: "agents", force: false, cwd });
    expect(installed).toEqual([path.join(cwd, AGENTS)]);
    expect(await files(AGENTS)).toEqual(["SKILL.md", "validate-tasks.mjs"]);
    expect(existsSync(path.join(cwd, ".claude"))).toBe(false);
  });

  it("installs into .claude/skills/to-issues with target claude", async () => {
    await installSkills({ target: "claude", force: false, cwd });
    expect(await files(CLAUDE)).toEqual(["SKILL.md", "validate-tasks.mjs"]);
    expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
  });

  it("installs into both with target both", async () => {
    await installSkills({ target: "both", force: false, cwd });
    expect(await files(AGENTS)).toEqual(["SKILL.md", "validate-tasks.mjs"]);
    expect(await files(CLAUDE)).toEqual(["SKILL.md", "validate-tasks.mjs"]);
  });

  it("refuses a second run and changes nothing", async () => {
    await installSkills({ target: "agents", force: false, cwd });
    const skill = path.join(cwd, AGENTS, "SKILL.md");
    await writeFile(skill, "edited");
    await expect(installSkills({ target: "agents", force: false, cwd })).rejects.toThrow(InstallError);
    expect(await readFile(skill, "utf8")).toBe("edited");
  });

  it("overwrites with force and removes stale files", async () => {
    await installSkills({ target: "agents", force: false, cwd });
    await writeFile(path.join(cwd, AGENTS, "SKILL.md"), "edited");
    await writeFile(path.join(cwd, AGENTS, "stale.txt"), "old");
    await installSkills({ target: "agents", force: true, cwd });
    expect(await files(AGENTS)).toEqual(["SKILL.md", "validate-tasks.mjs"]);
    expect(await readFile(path.join(cwd, AGENTS, "SKILL.md"), "utf8")).toContain("name: to-issues");
  });

  it("installs nothing when only one of two destinations exists", async () => {
    await mkdir(path.join(cwd, CLAUDE), { recursive: true });
    await expect(installSkills({ target: "both", force: false, cwd })).rejects.toThrow(/\.claude.*already exists/);
    expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
    expect(await files(CLAUDE)).toEqual([]);
  });
});

describe("the bundled skill", () => {
  it("has no HITL/AFK wording and points to the task folder and the validation script", async () => {
    const skill = await readFile(path.join(root, "skills", "to-issues", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: to-issues\ndescription: .+\n---/);
    expect(skill).not.toMatch(/HITL|AFK/);
    expect(skill).toContain(".agents/tasks/<id>.json");
    expect(skill).toContain("validate-tasks.mjs .agents/tasks");
  });

  it("validation script imports only node: builtins", async () => {
    const script = await readFile(path.join(root, "skills", "to-issues", "validate-tasks.mjs"), "utf8");
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
    expect(first.stdout).toContain(AGENTS);
    expect(await files(AGENTS)).toEqual(["SKILL.md", "validate-tasks.mjs"]);

    const second = await run([]);
    expect(second.exitCode).toBe(2);
    expect(second.stderr).toContain("already exists");

    expect((await run(["--force"])).exitCode).toBe(0);
  });

  it("installs both targets and rejects an unknown target with exit 2", async () => {
    expect((await run(["--target", "both"])).exitCode).toBe(0);
    expect(await files(CLAUDE)).toEqual(["SKILL.md", "validate-tasks.mjs"]);
    const bad = await run(["--target", "nope"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("agents, claude, both");
  });
});
