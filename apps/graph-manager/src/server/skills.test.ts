import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_MARKER, syncSkills, userSkillRoots } from "./skills.js";

async function engineWith(skills: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gm-engine-"));
  for (const [name, text] of Object.entries(skills)) {
    await mkdir(path.join(dir, "skills", name), { recursive: true });
    await writeFile(path.join(dir, "skills", name, "SKILL.md"), text);
  }
  return dir;
}

describe("syncSkills", () => {
  it("installs the engine's skills, replaces its own older copies and keeps the user's", async () => {
    const root = path.join(await mkdtemp(path.join(os.tmpdir(), "gm-skills-")), "skills");
    const engine = await engineWith({ "run-graph": "v1", "to-spec": "spec v1" });
    // The user's own to-spec: never replaced.
    await mkdir(path.join(root, "to-spec"), { recursive: true });
    await writeFile(path.join(root, "to-spec", "SKILL.md"), "mine");

    const first = await syncSkills(engine, [root]);
    expect(first.installed).toEqual([path.join(root, "run-graph")]);
    expect(first.kept).toEqual([path.join(root, "to-spec")]);
    expect(await readFile(path.join(root, "run-graph", "SKILL.md"), "utf8")).toBe("v1");
    expect(await readFile(path.join(root, "to-spec", "SKILL.md"), "utf8")).toBe("mine");

    // Same content: nothing to do.
    expect((await syncSkills(engine, [root])).installed).toEqual([]);

    // The server's skill changed (newer or older): its copy follows.
    await writeFile(path.join(engine, "skills", "run-graph", "SKILL.md"), "v0");
    expect((await syncSkills(engine, [root])).installed).toEqual([path.join(root, "run-graph")]);
    expect(await readFile(path.join(root, "run-graph", "SKILL.md"), "utf8")).toBe("v0");
    expect(await readFile(path.join(root, "run-graph", SKILL_MARKER), "utf8")).toMatch(/^[0-9a-f]{16}\n$/);
  });
});

describe("userSkillRoots", () => {
  const home = path.resolve("/h");
  const j = (...p: string[]) => path.join(home, ...p);

  it("uses CLAUDE_CONFIG_DIR when set, and ~/.agents/skills, first", () => {
    expect(userSkillRoots({}, home).slice(0, 2)).toEqual([j(".claude", "skills"), j(".agents", "skills")]);
    const roots = userSkillRoots({ CLAUDE_CONFIG_DIR: "/c" }, home);
    expect(roots.slice(0, 2)).toEqual([path.join(path.resolve("/c"), "skills"), j(".agents", "skills")]);
    expect(roots).not.toContain(j(".claude", "skills"));
  });

  it("includes every catalog agent's user skill folder, each once", () => {
    const roots = userSkillRoots({}, home);
    for (const d of [
      j(".pi", "agent", "skills"),
      j(".omp", "agent", "skills"),
      j(".copilot", "skills"),
      j(".qwen", "skills"),
      j(".codex", "skills"),
      j(".config", "opencode", "skills"),
    ]) {
      expect(roots.filter((r) => r === d)).toEqual([d]);
    }
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("puts the engine's skills into every agent's user skill folder of a temp HOME", async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "gm-home-"));
    const engine = await engineWith({ "run-graph": "r", "to-spec": "s", "to-tasks": "t" });
    const roots = userSkillRoots({}, tmpHome);
    await syncSkills(engine, roots);
    for (const root of roots) {
      for (const name of ["run-graph", "to-spec", "to-tasks"]) expect(existsSync(path.join(root, name, "SKILL.md"))).toBe(true);
    }
    expect(roots).toContain(path.join(tmpHome, ".copilot", "skills"));
  });

  it("honours PI_CODING_AGENT_DIR (pi and oh-my-pi) and COPILOT_HOME", () => {
    const roots = userSkillRoots({ PI_CODING_AGENT_DIR: "/pi", COPILOT_HOME: "/cp" }, home);
    const pi = path.join(path.resolve("/pi"), "skills");
    expect(roots.filter((r) => r === pi)).toEqual([pi]);
    expect(roots).toContain(path.join(path.resolve("/cp"), "skills"));
    expect(roots).not.toContain(j(".pi", "agent", "skills"));
    expect(roots).not.toContain(j(".omp", "agent", "skills"));
    expect(roots).not.toContain(j(".copilot", "skills"));
  });
});
