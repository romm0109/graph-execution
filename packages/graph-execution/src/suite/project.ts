import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isRepo, repoRoot } from "../git/git.js";
import { loadTestPlan, TEST_PLAN_FILE } from "../graph/testPlan.js";

export const PROJECT_FILE = "project.json";
export const CONTRACT_FILE = "contract.md";
const NAME = /^[A-Za-z0-9_-]+$/;

export const projectFileSchema = z.strictObject({
  name: z.string().regex(NAME, "use letters, digits, - and _"),
  repos: z
    .array(z.strictObject({ name: z.string().regex(NAME, "use letters, digits, - and _"), path: z.string().min(1) }))
    .min(2, "at least 2 repos"),
});

export interface ProjectRepo {
  name: string;
  /** Absolute, with links resolved: the root of the repo's checkout. */
  path: string;
  /** `<project>/tasks/<name>`, when that folder exists: the repo gets a feature run. */
  tasksDir?: string;
  /** `<project>/specs/<name>.md`, when that file exists. */
  spec?: string;
}

export interface Project {
  /** Absolute, with links resolved. */
  dir: string;
  name: string;
  /** `<project>/contract.md`. */
  contract: string;
  /** `<project>/test-plan.json`, when present. */
  testPlan?: string;
  /** In `project.json` order. */
  repos: ProjectRepo[];
}

/** Every problem of a project folder at once, in the style of `GraphError`. */
export class ProjectError extends Error {
  readonly problems: string[];
  constructor(problems: string[], dir?: string) {
    super(
      problems.length === 1
        ? problems[0]
        : `Invalid project ${dir === undefined ? PROJECT_FILE : `${slashes(dir)}/${PROJECT_FILE}`}:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "ProjectError";
    this.problems = problems;
  }
}

/** Messages name paths with `/`, whatever the OS. */
const slashes = (p: string): string => p.replaceAll("\\", "/");
const isDir = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * Reads `project.json` in `dir` and checks the fixed layout around it (`contract.md`, `specs/<name>.md`,
 * `tasks/<name>/`, `test-plan.json`). Throws a `ProjectError` listing every problem.
 */
export async function loadProject(dir: string): Promise<Project> {
  const given = path.resolve(dir);
  if (!isDir(given)) throw new ProjectError([`project folder not found: ${slashes(given)}`]);
  const root = realpathSync.native(given);

  let raw: string;
  try {
    raw = await readFile(path.join(root, PROJECT_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ProjectError([`no ${PROJECT_FILE} in ${slashes(given)}`]);
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ProjectError([`invalid JSON in ${PROJECT_FILE}: ${(err as Error).message}`]);
  }

  const problems: string[] = [];
  const parsed = projectFileSchema.safeParse(json);
  if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  // The entries with a string name and path go on to the checks below even when another field is wrong, so every
  // problem shows at once (a bad project name does not hide a repo path that is not a checkout).
  const listed: unknown[] = typeof json === "object" && json !== null && Array.isArray((json as { repos?: unknown }).repos) ? (json as { repos: unknown[] }).repos : [];
  const entries = listed.flatMap((r, i) => {
    if (typeof r !== "object" || r === null) return [];
    const { name, path: p } = r as { name?: unknown; path?: unknown };
    return typeof name === "string" && typeof p === "string" && p !== "" ? [{ i, name, path: p }] : [];
  });

  const repos: ProjectRepo[] = [];
  const names = new Set<string>();
  const byPath = new Map<string, string>();
  for (const r of entries) {
    const i = r.i;
    const shown = slashes(r.path);
    if (names.has(r.name)) problems.push(`repos.${i}.name: duplicate repo name "${r.name}"`);
    names.add(r.name);
    const resolved = path.resolve(root, r.path);
    if (!existsSync(resolved)) {
      problems.push(`repos.${i}.path: ${shown} does not exist`);
      continue;
    }
    const real = realpathSync.native(resolved);
    if (real === root) {
      problems.push(`repos.${i}.path: ${shown} is the project folder itself`);
      continue;
    }
    if (!isDir(real) || !(await isRepo(real)) || realpathSync.native(await repoRoot(real)) !== real) {
      problems.push(`repos.${i}.path: ${shown} is not the root of a git checkout`);
      continue;
    }
    const other = byPath.get(real);
    if (other !== undefined) {
      problems.push(`repos.${i}.path: ${shown} is the same repo as ${other}`);
      continue;
    }
    byPath.set(real, r.name);
    const tasksDir = path.join(root, "tasks", r.name);
    const spec = path.join(root, "specs", `${r.name}.md`);
    const hasTasks = isDir(tasksDir);
    const hasSpec = isFile(spec);
    if (hasTasks && !hasSpec) problems.push(`specs/${r.name}.md is missing (tasks/${r.name}/ exists)`);
    repos.push({ name: r.name, path: real, ...(hasTasks ? { tasksDir } : {}), ...(hasSpec ? { spec } : {}) });
  }

  const contract = path.join(root, CONTRACT_FILE);
  if (!isFile(contract)) problems.push(`${CONTRACT_FILE} is missing`);

  if (parsed.success) {
    const folders = (await readdir(path.join(root, "tasks"), { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const x of folders) if (!names.has(x)) problems.push(`tasks/${x}/ matches no repo in ${PROJECT_FILE}`);
    if (!entries.some((r) => isDir(path.join(root, "tasks", r.name)))) {
      problems.push("no repo has a tasks/<name>/ folder: nothing to change");
    }
  }

  const testPlan = path.join(root, TEST_PLAN_FILE);
  const hasPlan = existsSync(testPlan);
  if (hasPlan) {
    try {
      await loadTestPlan(root);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(message.startsWith(`${TEST_PLAN_FILE}: `) ? message : `${TEST_PLAN_FILE}: ${message}`);
    }
  }

  if (problems.length > 0 || !parsed.success) throw new ProjectError(problems, given);
  return { dir: root, name: parsed.data.name, contract, ...(hasPlan ? { testPlan } : {}), repos };
}
