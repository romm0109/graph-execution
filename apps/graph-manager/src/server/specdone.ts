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
