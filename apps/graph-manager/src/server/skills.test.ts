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
  it("uses CLAUDE_CONFIG_DIR when set, and ~/.agents/skills", () => {
    expect(userSkillRoots({}, "/h")).toEqual(["/h/.claude/skills", "/h/.agents/skills"]);
    expect(userSkillRoots({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toEqual(["/c/skills", "/h/.agents/skills"]);
  });
});
