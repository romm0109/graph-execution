import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureExcluded } from "../git/git.js";
import { RUNS_DIR } from "../state/paths.js";
import { SUITE_FILE } from "../suite/state.js";

/** Folder in a member repo's runs dir holding one link per multi-repo suite that uses the repo. Starts with `_`, so scan never takes it for a run. */
export const PROJECT_LINKS_DIR = "_projects";

export interface ProjectLink {
  suiteId: string;
  /** Absolute path of the suite folder (in the project folder). */
  suiteDir: string;
  /** Absolute path of the project folder. */
  project: string;
}

const linksDir = (repo: string): string => path.join(repo, RUNS_DIR, PROJECT_LINKS_DIR);
const linkFile = (repo: string, suiteId: string): string => path.join(linksDir(repo), `${suiteId}.json`);

/** Writes `<repo>/.graph-execution/_projects/<suiteId>.json` ({ suiteDir, project }), after ensureExcluded(repo, `${RUNS_DIR}/`). */
export async function linkProjectSuite(repo: string, link: ProjectLink): Promise<void> {
  await ensureExcluded(repo, `${RUNS_DIR}/`);
  await mkdir(linksDir(repo), { recursive: true });
  const body = { suiteDir: path.resolve(link.suiteDir), project: path.resolve(link.project) };
  await writeFile(linkFile(repo, link.suiteId), `${JSON.stringify(body, null, 2)}\n`);
}

/** Every readable link of `repo`, whether its suite folder exists or not. */
async function readAllLinks(repo: string): Promise<ProjectLink[]> {
  const names = (await readdir(linksDir(repo)).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  const out: ProjectLink[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(path.join(linksDir(repo), name), "utf8")) as { suiteDir?: unknown; project?: unknown };
      if (typeof raw.suiteDir !== "string" || typeof raw.project !== "string") continue;
      out.push({ suiteId: name.slice(0, -".json".length), suiteDir: raw.suiteDir, project: raw.project });
    } catch {
      // unreadable: skipped
    }
  }
  return out;
}

const suiteExists = (link: ProjectLink): boolean => existsSync(path.join(link.suiteDir, SUITE_FILE));

/** The links of `repo` whose `<suiteDir>/suite.json` still exists; unreadable files are skipped. */
export async function readProjectLinks(repo: string): Promise<ProjectLink[]> {
  return (await readAllLinks(repo)).filter(suiteExists);
}

/** Removes the link of `suiteId` from `repo` (no error when absent). */
export async function unlinkProjectSuite(repo: string, suiteId: string): Promise<void> {
  await rm(linkFile(repo, suiteId), { force: true });
}

/** Removes the links whose suite folder is gone. */
export async function pruneProjectLinks(repo: string): Promise<void> {
  for (const link of await readAllLinks(repo)) {
    if (!suiteExists(link)) await unlinkProjectSuite(repo, link.suiteId);
  }
}
