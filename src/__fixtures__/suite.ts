import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { gitOut, tempRepo } from "./repo.js";
import { defaultSpawn, type SpawnFeature } from "../suite/spawn.js";
import { suiteStateSchema } from "../suite/state.js";

// Real children run the built CLI; vitest.global-setup.ts builds dist/ before the suite.
export const root = fileURLToPath(new URL("../..", import.meta.url));
export const cliPath = path.join(root, "dist", "cli.js");
export const fixtures = path.join(root, "src", "__fixtures__");

export async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await tempRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** `n` temp repos plus one plain folder that is not a repo; all removed afterwards. */
export async function withRepos(n: number, fn: (repos: string[], folder: string) => Promise<void>): Promise<void> {
  const repos: string[] = [];
  const folder = await mkdtemp(path.join(tmpdir(), "suite-folder-"));
  try {
    for (let i = 0; i < n; i++) repos.push(await tempRepo());
    await fn(repos, folder);
  } finally {
    for (const dir of [...repos, folder]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Copies the diamond fixture and the spec into `<repo>/<name>` and `<repo>/PRD-<name>.md`. */
export async function addFeature(repo: string, name: string): Promise<{ tasksDir: string; prd: string }> {
  await cp(path.join(fixtures, "diamond"), path.join(repo, name), { recursive: true });
  await cp(path.join(fixtures, "spec.md"), path.join(repo, `PRD-${name}.md`));
  return { tasksDir: path.join(repo, name), prd: path.join(repo, `PRD-${name}.md`) };
}

export async function addTasks(repo: string, name: string, ids: string[]): Promise<{ tasksDir: string; prd: string }> {
  await mkdir(path.join(repo, name), { recursive: true });
  for (const id of ids) {
    await writeFile(
      path.join(repo, name, `${id}.json`),
      JSON.stringify({ id, content: `Do ${id}.`, dependencies: [], validate: null }),
    );
  }
  await cp(path.join(fixtures, "spec.md"), path.join(repo, `PRD-${name}.md`));
  return { tasksDir: path.join(repo, name), prd: path.join(repo, `PRD-${name}.md`) };
}

export const commitAll = async (repo: string): Promise<void> => {
  await gitOut(repo, ["add", "-A"]);
  await gitOut(repo, ["commit", "-q", "-m", "features"]);
};

export const suiteDirIn = async (repo: string): Promise<string> => {
  const { readdir } = await import("node:fs/promises");
  const name = (await readdir(path.join(repo, ".graph-execution"))).find((n) => n.startsWith("suite-"));
  expect(name).toBeDefined();
  return path.join(repo, ".graph-execution", name!);
};

export const loadSuite = async (repo: string) =>
  suiteStateSchema.parse(JSON.parse(await readFile(path.join(await suiteDirIn(repo), "suite.json"), "utf8")));

export async function until(cond: () => boolean, ms = 40_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const failTwice = { commit: false, write: {} };
export const failScript = { "task:1": { attempts: [failTwice, failTwice, failTwice] } };

/** Spawn that records the args of every start. */
export function recordingSpawn(repo: string, starts: string[][]): SpawnFeature {
  const base = defaultSpawn(cliPath, repo);
  return (args, env, logFile) => {
    starts.push(args);
    return base(args, env, logFile);
  };
}

export async function withScript(repo: string, script: unknown, fn: (file: string) => Promise<void>): Promise<void> {
  const file = path.join(repo, ".git", "fake-script.json");
  await writeFile(file, JSON.stringify(script));
  process.env.GRAPH_EXECUTION_FAKE_SCRIPT = file;
  try {
    await fn(file);
  } finally {
    delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
  }
}
