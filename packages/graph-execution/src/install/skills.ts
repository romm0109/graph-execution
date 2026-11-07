import { existsSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALL_TARGETS = ["agents", "claude", "both"] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

export interface InstallSkillsOptions {
  target: InstallTarget;
  force: boolean;
  /** Destinations are relative to this directory, not to the package. */
  cwd: string;
}

/** Raised when a destination already exists and `force` is not set; nothing has been installed. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** The bundled skills: `<package>/skills/`, reached from `dist/install/` or `src/install/`. */
const SKILLS_SOURCE = fileURLToPath(new URL("../../skills/", import.meta.url));

const ROOTS: Record<InstallTarget, string[]> = {
  agents: [path.join(".agents", "skills")],
  claude: [path.join(".claude", "skills")],
  both: [path.join(".agents", "skills"), path.join(".claude", "skills")],
};

export interface InstallResult {
  /** Absolute paths of the skill folders written. */
  installed: string[];
  /** Absolute paths of the skill folders left alone because they exist. */
  skipped: string[];
}

async function bundledSkills(): Promise<string[]> {
  const entries = await readdir(SKILLS_SOURCE, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(path.join(SKILLS_SOURCE, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/**
 * Copies every bundled skill into the selected destinations under `cwd`. Each skill folder is decided on its own:
 * an existing one is skipped unless `force`. Throws only when nothing was installed and something was skipped.
 */
export async function installSkills({ target, force, cwd }: InstallSkillsOptions): Promise<InstallResult> {
  const skills = await bundledSkills();
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const root of ROOTS[target]) {
    for (const skill of skills) {
      const dest = path.resolve(cwd, root, skill);
      if (existsSync(dest) && !force) {
        skipped.push(dest);
        continue;
      }
      if (force) await rm(dest, { recursive: true, force: true });
      await cp(path.join(SKILLS_SOURCE, skill), dest, { recursive: true });
      installed.push(dest);
    }
  }
  if (installed.length === 0 && skipped.length > 0) {
    throw new InstallError(
      `${skipped.map((d) => path.relative(cwd, d)).join(" and ")} already exists; nothing was installed (use --force to overwrite)`,
    );
  }
  return { installed, skipped };
}
