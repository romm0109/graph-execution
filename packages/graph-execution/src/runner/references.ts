import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ReferenceFile } from "../agents/task.js";

/** How a path of the user's repo is named in prompts: relative to the repo root when inside it. */
const repoName = (repo: string, file: string): string => {
  const rel = path.relative(repo, path.resolve(file));
  return rel.startsWith("..") || path.isAbsolute(rel) ? path.resolve(file) : rel;
};

/**
 * Copies the spec and the task files into `<runDir>/context/`, outside every worktree, and returns where they are
 * for the agents' prompts. The run never needs them committed: worktrees only hold committed files, so a spec or a
 * task folder the user has not committed would otherwise be invisible to the agents. The copy is taken again on every
 * start and resume; the input hashes guarantee it has not changed. A path that does not exist is left out.
 */
export async function snapshotReferences(
  repo: string,
  runDir: string,
  specPath: string,
  tasksDir: string,
): Promise<ReferenceFile[]> {
  const dir = path.join(runDir, "context");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const refs: ReferenceFile[] = [];
  if (existsSync(specPath)) {
    const spec = path.join(dir, "spec", path.basename(specPath));
    await cp(path.resolve(specPath), spec);
    refs.push({ what: "Spec (PRD)", name: repoName(repo, specPath), path: spec });
  }
  if (existsSync(tasksDir)) {
    const tasks = path.join(dir, "tasks");
    await cp(path.resolve(tasksDir), tasks, { recursive: true });
    refs.push({ what: "Task files of this run", name: `${repoName(repo, tasksDir)}/`, path: `${tasks}/` });
  }
  return refs;
}
