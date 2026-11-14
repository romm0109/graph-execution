import { access, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const RUNS_FOLDER = ".graph-execution";

const exists = async (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Moves the run's spec into a `done/` folder next to it (`docs/prd/x.md` → `docs/prd/done/x.md`): `git mv` when it is
 * tracked, a plain rename otherwise. Returns the new path relative to the workspace (with `/`) when it moved; undefined
 * when it was left alone (outside the workspace, under `.graph-execution/`, already in `done/`, missing, destination
 * taken) or anything failed. Never throws.
 */
export async function moveSpecToDone(wsPath: string, specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    const abs = path.resolve(wsPath, specPath);
    const name = path.basename(abs);
    if (path.basename(path.dirname(abs)) === "done") return undefined;
    if (!(await exists(abs))) return undefined;
    const realWs = await realpath(wsPath);
    const realDir = await realpath(path.dirname(abs));
    const rel = path.relative(realWs, path.join(realDir, name));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const parts = rel.split(path.sep);
    if (parts[0] === RUNS_FOLDER) return undefined;
    const doneDir = path.join(realDir, "done");
    const dest = path.join(doneDir, name);
    if (await exists(dest)) return undefined;
    const relPosix = parts.join("/");
    const destRel = path.relative(realWs, dest).split(path.sep).join("/");
    await mkdir(doneDir, { recursive: true });
    const opts = { cwd: realWs, reject: false, stdin: "ignore" as const, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
    const tracked = await execa("git", ["ls-files", "--error-unmatch", "--", relPosix], opts);
    let moved = false;
    if (tracked.exitCode === 0) moved = (await execa("git", ["mv", "--", relPosix, destRel], opts)).exitCode === 0;
    if (!moved) await rename(path.join(realDir, name), dest);
    return destRel;
  } catch {
    return undefined;
  }
}

type GitRun = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * `moveSpecToDone` through git alone (works on any WorkspaceHost): moves `specRel` (relative to the repo root) to a
 * `done/` folder next to it, staged. Returns the new path (with `/`) when it moved; undefined when it was left alone
 * (outside the repo, under `.graph-execution/`, already in `done/`, missing, destination taken) or anything failed.
 * Never throws.
 */
export async function moveSpecToDoneGit(git: GitRun, specRel: string | undefined): Promise<string | undefined> {
  if (!specRel) return undefined;
  try {
    const rel = path.posix.normalize(specRel.split(path.sep).join("/"));
    if (rel === "" || rel === "." || rel.startsWith("../") || rel === ".." || path.posix.isAbsolute(rel) || path.isAbsolute(specRel)) return undefined;
    const parts = rel.split("/");
    if (parts[0] === RUNS_FOLDER) return undefined;
    if (parts.length >= 2 && parts[parts.length - 2] === "done") return undefined;
    const dest = [...parts.slice(0, -1), "done", parts[parts.length - 1]!].join("/");
    const ok = async (args: string[]): Promise<boolean> => (await git(args)).exitCode === 0;
    if (await ok(["ls-files", "--error-unmatch", "--", dest])) return undefined;
    if (await ok(["cat-file", "-e", `:${dest}`])) return undefined;
    const untracked = await git(["ls-files", "--others", "--", dest]);
    if (untracked.exitCode !== 0 || untracked.stdout.trim() !== "") return undefined;
    if (!(await ok(["add", "--", rel]))) return undefined;
    const blob = await git(["rev-parse", `:${rel}`]);
    if (blob.exitCode !== 0) return undefined;
    const staged = await git(["ls-files", "-s", "--", rel]);
    const mode = /^(\d{6}) /.exec(staged.stdout.trim())?.[1];
    if (staged.exitCode !== 0 || !mode) return undefined;
    if (!(await ok(["update-index", "--add", "--cacheinfo", `${mode},${blob.stdout.trim()},${dest}`]))) return undefined;
    if (!(await ok(["checkout-index", "--", dest]))) return undefined;
    if (!(await ok(["rm", "-q", "-f", "--", rel]))) return undefined;
    return dest;
  } catch {
    return undefined;
  }
}
