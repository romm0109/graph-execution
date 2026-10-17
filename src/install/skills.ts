import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
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

/** The bundled skill: `<package>/skills/to-tasks`, reached from `dist/install/` or `src/install/`. */
const SKILL_SOURCE = fileURLToPath(new URL("../../skills/to-tasks/", import.meta.url));

const DESTINATIONS: Record<InstallTarget, string[]> = {
  agents: [path.join(".agents", "skills", "to-tasks")],
  claude: [path.join(".claude", "skills", "to-tasks")],
  both: [path.join(".agents", "skills", "to-tasks"), path.join(".claude", "skills", "to-tasks")],
};

/**
 * Copies the bundled `to-tasks` skill into the selected destinations under `cwd` (PRD §7.12) and returns the
 * installed paths. Refuses before copying anything if a destination exists, unless `force`.
 */
export async function installSkills({ target, force, cwd }: InstallSkillsOptions): Promise<string[]> {
  const destinations = DESTINATIONS[target].map((d) => path.resolve(cwd, d));
  if (!force) {
    const existing = destinations.filter((d) => existsSync(d));
    if (existing.length > 0) {
      throw new InstallError(
        `${existing.map((d) => path.relative(cwd, d)).join(" and ")} already exists; nothing was installed (use --force to overwrite)`,
      );
    }
  }
  for (const dest of destinations) {
    if (force) await rm(dest, { recursive: true, force: true });
    await cp(SKILL_SOURCE, dest, { recursive: true });
  }
  return destinations;
}
