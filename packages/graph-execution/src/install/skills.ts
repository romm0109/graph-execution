import { existsSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RM_RETRY } from "../git/git.js";
import { PROVIDER_CATALOG } from "../providers/catalog.js";

const AGENTS_DIR = path.join(".agents", "skills");
const CLAUDE_DIR = path.join(".claude", "skills");
const skillDir = (dir: string): string => path.join(...dir.split("/"));
const unique = (dirs: string[]): string[] => [...new Set(dirs)];

/**
 * Where each target installs, relative to the cwd. `agents`, `claude` and `both` are the original targets; every
 * engine provider id installs into that provider's project skill folder; `all` covers every catalog provider plus
 * `.agents/skills`, each folder once.
 */
const ROOTS: Record<string, string[]> = {
  agents: [AGENTS_DIR],
  claude: [CLAUDE_DIR],
  both: [AGENTS_DIR, CLAUDE_DIR],
  ...Object.fromEntries(PROVIDER_CATALOG.filter((p) => p.engine).map((p) => [p.id, [skillDir(p.projectSkillDir)]])),
  all: unique([AGENTS_DIR, ...PROVIDER_CATALOG.map((p) => skillDir(p.projectSkillDir))]),
};

export const INSTALL_TARGETS: readonly string[] = Object.keys(ROOTS);
export type InstallTarget = string;

/** The folders (relative to the cwd) a target installs into. */
export function installRoots(target: InstallTarget): string[] {
  const roots = ROOTS[target];
  if (!roots) throw new InstallError(`unknown target ${target}; must be one of: ${INSTALL_TARGETS.join(", ")}`);
  return roots;
}

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
  for (const root of installRoots(target)) {
    for (const skill of skills) {
      const dest = path.resolve(cwd, root, skill);
      if (existsSync(dest) && !force) {
        skipped.push(dest);
        continue;
      }
      if (force) await rm(dest, { recursive: true, force: true, ...RM_RETRY });
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
