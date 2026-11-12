// The agents in graph-manager's terminals use the skills of graph-manager's own engine (to-spec, to-tasks, run-graph),
// never an older or newer copy a workspace checks in: a workspace on an old branch would teach the agent an engine
// that is not the one it runs. At startup the engine's bundled skills are copied to the user-level skill folders,
// which Claude Code prefers over a project's `.claude/skills`.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROVIDER_CATALOG } from "graph-execution/api";

/** The file graph-manager writes into each skill folder it installs; a folder without it is the user's and is kept. */
export const SKILL_MARKER = ".graph-manager";

/**
 * The user-level skill folders of every catalog agent: Claude Code's (`$CLAUDE_CONFIG_DIR` or `~/.claude`) and the
 * shared `~/.agents` first, then each provider's `userSkillDirs` (relative to HOME), resolved and deduplicated.
 * `PI_CODING_AGENT_DIR` (read by pi and oh-my-pi) and `COPILOT_HOME` move those agents' folders.
 */
export function userSkillRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const overrides = new Map<string, string>();
  if (env.CLAUDE_CONFIG_DIR) overrides.set(".claude/skills", path.join(path.resolve(env.CLAUDE_CONFIG_DIR), "skills"));
  if (env.PI_CODING_AGENT_DIR) {
    const pi = path.join(path.resolve(env.PI_CODING_AGENT_DIR), "skills");
    overrides.set(".pi/agent/skills", pi);
    overrides.set(".omp/agent/skills", pi);
  }
  if (env.COPILOT_HOME) overrides.set(".copilot/skills", path.join(path.resolve(env.COPILOT_HOME), "skills"));
  const rels = [".claude/skills", ".agents/skills", ...PROVIDER_CATALOG.flatMap((p) => p.userSkillDirs)];
  const roots: string[] = [];
  for (const rel of rels) {
    const dir = overrides.get(rel) ?? path.resolve(home, ...rel.split("/"));
    if (!roots.includes(dir)) roots.push(dir);
  }
  return roots;
}

export interface SyncResult {
  /** Skill folders written (new, or graph-manager's own of another version). */
  installed: string[];
  /** Skill folders left alone because the user made them. */
  kept: string[];
}

/** A hash of every file under `dir` (paths and contents), so any change of a skill is a new version. */
async function hashDir(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (rel: string): Promise<void> => {
    const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) await visit(r);
      else if (e.isFile()) hash.update(`${r}\0`).update(await readFile(path.join(dir, r))).update("\0");
    }
  };
  await visit("");
  return hash.digest("hex").slice(0, 16);
}

/**
 * Copies every `<engineDir>/skills/<name>` (a folder with a SKILL.md) into each root, tagged with a hash of its files.
 * A folder graph-manager installed is replaced when the hash differs; a folder without the marker is never touched.
 */
export async function syncSkills(engineDir: string, roots: string[]): Promise<SyncResult> {
  const source = path.join(engineDir, "skills");
  const names = (await readdir(source, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && existsSync(path.join(source, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
  const result: SyncResult = { installed: [], kept: [] };
  const versions = new Map(await Promise.all(names.map(async (n) => [n, await hashDir(path.join(source, n))] as const)));
  for (const root of roots) {
    for (const name of names) {
      const version = versions.get(name) ?? "";
      const dest = path.join(root, name);
      if (existsSync(dest)) {
        const marker = await readFile(path.join(dest, SKILL_MARKER), "utf8").catch(() => undefined);
        if (marker === undefined) {
          result.kept.push(dest);
          continue;
        }
        if (marker.trim() === version) continue;
        await rm(dest, { recursive: true, force: true });
      }
      await mkdir(root, { recursive: true });
      await cp(path.join(source, name), dest, { recursive: true });
      await writeFile(path.join(dest, SKILL_MARKER), `${version}\n`);
      result.installed.push(dest);
    }
  }
  return result;
}
