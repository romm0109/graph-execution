import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { Workspace } from "./workspaces.js";

/** The folder of all projects, inside the workspaces dir. A dot folder: `listWorkspaces` never lists it. */
export const PROJECTS_DIR = ".projects";
export const PROJECT_FILE = "project.json";

/** The engine's rule for a project name (docs/prd/multi-repo.md, "Engine: the project manifest"). */
export const PROJECT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A saved, named group of workspaces of one forge (docs/prd/multi-repo.md, MR-01). */
export interface Project {
  /** The name's slug (`projectIdOf`): the store key and the folder name. */
  id: string;
  name: string;
  /** Workspace ids, in `project.json` order. */
  workspaces: string[];
  createdAt: string;
}

/** What `project.json` holds: the engine reads it. `path` is relative to the project folder, with "/". */
export interface ProjectFile {
  name: string;
  repos: { name: string; path: string }[];
}

/** Creating or changing a project folder failed; `status` is the HTTP status to reply with. */
export class ProjectFolderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `<workspacesDir>/.projects/<id>` (absolute). */
export function projectDirOf(workspacesDir: string, id: string): string {
  return path.join(path.resolve(workspacesDir), PROJECTS_DIR, id);
}

/** The id of a project with this (valid) name: lower case, `_` as `-`. So `[a-z0-9-]+`, never `~` or `.`. */
export function projectIdOf(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * The name under `repos/` of each workspace, by workspace id: the last segment of its path with every character
 * outside `[A-Za-z0-9_-]` as `-`, then `-2`, `-3`, … on a clash, in the order given. A workspace in `keep` keeps
 * that name. Names differing only in case clash too (Windows and macOS folders).
 */
export function repoNamesOf(workspaces: Workspace[], keep: Map<string, string> = new Map()): Map<string, string> {
  const used = new Set<string>();
  for (const ws of workspaces) {
    const kept = keep.get(ws.id);
    if (kept !== undefined) used.add(kept.toLowerCase());
  }
  const names = new Map<string, string>();
  for (const ws of workspaces) {
    const kept = keep.get(ws.id);
    if (kept !== undefined) {
      names.set(ws.id, kept);
      continue;
    }
    const base = (ws.fullPath.split("/").pop() ?? "").replace(/[^A-Za-z0-9_-]/g, "-") || "repo";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    names.set(ws.id, name);
  }
  return names;
}

/** The folder's `project.json`, or undefined when it is missing or not of the expected shape. */
export async function readProjectFile(dir: string): Promise<ProjectFile | undefined> {
  try {
    const json: unknown = JSON.parse(await readFile(path.join(dir, PROJECT_FILE), "utf8"));
    if (typeof json !== "object" || json === null) return undefined;
    const { name, repos } = json as { name?: unknown; repos?: unknown };
    if (typeof name !== "string" || !Array.isArray(repos)) return undefined;
    const out: ProjectFile["repos"] = [];
    for (const r of repos as { name?: unknown; path?: unknown }[]) {
      if (typeof r?.name !== "string" || typeof r.path !== "string") return undefined;
      out.push({ name: r.name, path: r.path });
    }
    return { name, repos: out };
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await execa("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, reject: false, stdin: "ignore" });
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

async function mustGit(cwd: string, args: string[], what: string): Promise<void> {
  const res = await git(cwd, args);
  if (!res.ok) throw new ProjectFolderError(500, `${what} failed: ${lastLine(res.stderr || res.stdout) || "unknown error"}`);
}

/** Commits what is staged. Signing is off: nobody is there to unlock a key. */
function commit(dir: string, message: string): Promise<void> {
  return mustGit(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], "git commit");
}

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

async function isLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function writeProjectFile(dir: string, name: string, workspaces: Workspace[], names: Map<string, string>): Promise<void> {
  const file: ProjectFile = {
    name,
    repos: workspaces.map((ws) => {
      const repo = names.get(ws.id)!;
      return { name: repo, path: `repos/${repo}` };
    }),
  };
  await writeFile(path.join(dir, PROJECT_FILE), JSON.stringify(file, null, 2) + "\n");
}

/**
 * Makes the project's folder: a local git repo (never a remote) with `project.json`, a `.gitignore`, one link per
 * workspace under `repos/` and a first commit. Throws a 409 when the folder exists; removes it again when a step fails.
 */
export async function createProjectFolder(workspacesDir: string, project: Project, workspaces: Workspace[]): Promise<void> {
  const dir = projectDirOf(workspacesDir, project.id);
  if (existsSync(dir)) throw new ProjectFolderError(409, `project folder ${dir} already exists`);
  await mkdir(dir, { recursive: true });
  try {
    await mustGit(dir, ["init", "-q", "-b", "main"], "git init");
    // The engine and agents commit here later too: without an identity from the machine, give the repo its own.
    if ((await git(dir, ["config", "user.email"])).stdout === "") {
      await mustGit(dir, ["config", "user.name", "graph-manager"], "git config");
      await mustGit(dir, ["config", "user.email", "graph-manager@localhost"], "git config");
    }
    const names = repoNamesOf(workspaces);
    await writeProjectFile(dir, project.name, workspaces, names);
    await writeFile(path.join(dir, ".gitignore"), "repos/\n.graph-execution/\n");
    await mkdir(path.join(dir, "repos"));
    for (const ws of workspaces) await symlink(ws.path, path.join(dir, "repos", names.get(ws.id)!), LINK_TYPE);
    await mustGit(dir, ["add", "--", PROJECT_FILE, ".gitignore"], "git add");
    await commit(dir, `chore: create project ${project.name}`);
  } catch (err) {
    await removeProjectFolder(workspacesDir, project.id).catch(() => undefined);
    throw err;
  }
}

/**
 * Makes the folder match `workspaces`: a workspace already linked keeps its name, links of workspaces that left are
 * removed (the link only), new ones are added, and `project.json` is rewritten and committed when it changed.
 * A missing folder is created again.
 */
export async function syncProjectFolder(workspacesDir: string, project: Project, workspaces: Workspace[]): Promise<void> {
  const dir = projectDirOf(workspacesDir, project.id);
  if (!existsSync(dir)) return createProjectFolder(workspacesDir, project, workspaces);
  const reposDir = path.join(dir, "repos");
  await mkdir(reposDir, { recursive: true });

  // Which workspace each current repo name belongs to, by where its link points.
  const keep = new Map<string, string>();
  for (const repo of (await readProjectFile(dir))?.repos ?? []) {
    const link = path.join(reposDir, repo.name);
    const ws = workspaces.find((w) => !keep.has(w.id) && sameDir(link, w.path));
    if (ws) keep.set(ws.id, repo.name);
  }
  const names = repoNamesOf(workspaces, keep);
  const wanted = new Map(workspaces.map((ws) => [names.get(ws.id)!, ws] as const));

  for (const entry of await readdir(reposDir)) {
    const link = path.join(reposDir, entry);
    if (!(await isLink(link))) continue;
    const ws = wanted.get(entry);
    // No `recursive`: this removes the link, never what it points to.
    if (!ws || !sameDir(link, ws.path)) await rm(link);
  }
  for (const [name, ws] of wanted) {
    const link = path.join(reposDir, name);
    if (await isLink(link)) continue;
    if (existsSync(link)) throw new ProjectFolderError(409, `${link} exists and is not a link`);
    await symlink(ws.path, link, LINK_TYPE);
  }

  await writeProjectFile(dir, project.name, workspaces, names);
  if ((await git(dir, ["status", "--porcelain", "--", PROJECT_FILE])).stdout !== "") {
    await mustGit(dir, ["add", "--", PROJECT_FILE], "git add");
    await commit(dir, "chore: update project repos");
  }
}

/** Removes the project's folder. The links under `repos/` go first, one by one, so no delete can walk into a workspace. */
export async function removeProjectFolder(workspacesDir: string, id: string): Promise<void> {
  const dir = projectDirOf(workspacesDir, id);
  const reposDir = path.join(dir, "repos");
  let entries: string[] = [];
  try {
    entries = await readdir(reposDir);
  } catch {
    // no repos/ folder
  }
  for (const entry of entries) {
    const link = path.join(reposDir, entry);
    if (await isLink(link)) await rm(link);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
