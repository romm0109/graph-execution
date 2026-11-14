// The git half of Create PR for a project run in a run container (docs/prd/hosted-sessions.md, "Hosted runs"): the
// workspace agent commits each changed repository on `gm/<runId>` (spec and contract copied to `docs/prd/done/`, as
// project-pr.ts does locally) and pushes it; the control plane then opens and links the PRs through the forge.
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { gitAuthArgs } from "./forges.js";
import type { GitAuth } from "./host/types.js";
import { lastLine, scrub } from "./pr.js";
import { baseBodyOf, titleOf } from "./project-pr.js";
import { PROJECT_NAME, projectDirOf, readProjectFile } from "./projects.js";
import { listWorkspaces } from "./workspaces.js";

/** One repository of the project after the commit: `pushed` when `gm/<runId>` is on its origin. */
export interface ProjectRepoCommit {
  name: string;
  fullPath: string;
  /** The PR title and body (without the related section). */
  title: string;
  body: string;
  /** False: the repository has no changes, and gets no PR. */
  changed: boolean;
  pushed: boolean;
  error?: string;
}

const RUNS_FOLDER = ".graph-execution";
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await execa("git", args, { cwd, env: gitEnv(), reject: false, stdin: "ignore" });
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

const exists = (file: string): Promise<boolean> =>
  readFile(file).then(
    () => true,
    () => false,
  );

/** Commits and pushes every changed repository of the project folder `<workspacesDir>/.projects/<projectId>`. */
export async function commitProjectRun(p: { workspacesDir: string; projectId: string; runId: string; auth?: GitAuth }): Promise<ProjectRepoCommit[]> {
  const dir = projectDirOf(p.workspacesDir, p.projectId);
  const file = await readProjectFile(dir);
  if (!file) throw new Error("the project folder has no project.json");
  const project = PROJECT_NAME.test(file.name) ? file.name : p.projectId;
  const branch = `gm/${p.runId}`;
  const token = p.auth?.token ?? "";
  const all = await listWorkspaces(p.workspacesDir);
  const reals = await Promise.all(all.map((w) => realpath(w.path).catch(() => undefined)));
  const out: ProjectRepoCommit[] = [];
  for (const repo of file.repos) {
    const real = await realpath(path.resolve(dir, repo.path)).catch(() => undefined);
    const ws = real === undefined ? undefined : all[reals.indexOf(real)];
    const title = await titleOf(dir, repo.name, project, p.runId);
    const body = await baseBodyOf(dir, repo.name, project, p.runId);
    const row: ProjectRepoCommit = { name: repo.name, fullPath: ws?.fullPath ?? repo.name, title, body, changed: false, pushed: false };
    out.push(row);
    if (!ws || real === undefined) {
      row.error = "the clone of this repository is missing";
      continue;
    }
    const status = await git(ws.path, ["--no-optional-locks", "status", "--porcelain", "--", ".", `:(exclude)${RUNS_FOLDER}`]);
    if (!status.ok || status.stdout === "") continue;
    row.changed = true;
    const must = async (args: string[]): Promise<void> => {
      const res = await git(ws.path, args);
      if (!res.ok) throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} failed: ${lastLine(res.stderr || res.stdout)}`);
    };
    try {
      await must(["checkout", "-q", "-b", branch]);
      const doneDir = path.join(ws.path, "docs", "prd", "done");
      await mkdir(doneDir, { recursive: true });
      const spec = path.join(dir, "specs", `${repo.name}.md`);
      if (await exists(spec)) await copyFile(spec, path.join(doneDir, `${project}.md`));
      const contract = path.join(dir, "contract.md");
      if (await exists(contract)) await copyFile(contract, path.join(doneDir, `${project}-contract.md`));
      await must(["add", "-A", "--", "."]);
      await must(["reset", "-q", "--", RUNS_FOLDER]);
      const email = await git(ws.path, ["config", "user.email"]);
      const identity = email.stdout === "" ? ["-c", "user.name=graph-manager", "-c", "user.email=graph-manager@localhost"] : [];
      await must([...identity, "commit", "-q", "-m", title, "-m", body]);
      await must([...(p.auth ? gitAuthArgs(p.auth.forge, p.auth.token) : []), "push", "-q", "-u", "origin", branch]);
      row.pushed = true;
    } catch (err) {
      row.error = scrub(err instanceof Error ? err.message : String(err), token);
    }
  }
  return out;
}
