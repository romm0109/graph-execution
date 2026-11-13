/** What an API client sent for a run (docs/prd/automation-api.md): kept in the data dir, copied into a sandbox's workspace. */
import { existsSync } from "node:fs";
import { chown, mkdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_DIR } from "graph-execution/api";
import type { AppContext } from "./app.js";
import type { Workspace } from "./workspaces.js";

/** `<dataDir>/inputs/<runId>`: what an API client sent for a run (content, refs, reject feedback). */
export const inputsDirOf = (dataDir: string, runId: string): string => path.join(dataDir, "inputs", runId);

/** Writes the files (mode 600) into `dir`; returns the folders it created (outermost first) and the files. */
async function writeAll(dir: string, files: { name: string; text: string }[]): Promise<string[]> {
  const made = await mkdir(dir, { recursive: true });
  const created: string[] = [];
  if (made) {
    for (let d = dir; d.length >= made.length; d = path.dirname(d)) created.unshift(d);
  }
  for (const f of files) {
    const file = path.join(dir, f.name);
    await writeFile(file, f.text, { mode: 0o600 });
    created.push(file);
  }
  return created;
}

/**
 * Writes the files (mode 600) to `<dataDir>/inputs/<runId>/`. A sandboxed run can't see the data dir (only the
 * workspace is mounted, at the same path), so for one they are also copied into `<ws>/.graph-execution/<runId>/inputs/`,
 * owned by the workspace's owner (as sandbox.ts does for the reviewers copy). Returns, per file name, the path to
 * pass to the engine: the data-dir path, or for a sandbox the workspace-relative path with "/" separators.
 */
export async function writeRunInputs(
  ctx: AppContext,
  ws: Workspace,
  runId: string,
  files: { name: string; text: string }[],
  sandboxed: boolean,
): Promise<Record<string, string>> {
  const dir = inputsDirOf(ctx.config.dataDir, runId);
  await writeAll(dir, files);
  const out: Record<string, string> = {};
  if (!sandboxed) {
    for (const f of files) out[f.name] = path.join(dir, f.name);
    return out;
  }
  const wsDir = path.join(ws.path, RUNS_DIR, runId, "inputs");
  const created = await writeAll(wsDir, files);
  if (process.platform !== "win32") {
    const st = await stat(ws.path);
    // Folders and files graph-manager makes belong to the workspace owner, as if the engine had made them.
    for (const p of created) await chown(p, st.uid, st.gid).catch(() => undefined);
  }
  for (const f of files) out[f.name] = [RUNS_DIR, runId, "inputs", f.name].join("/");
  return out;
}

/**
 * Removes the inputs of a run that did not start (writeRunInputs before a start that failed): `<dataDir>/inputs/<runId>/`
 * and `<ws>/.graph-execution/<runId>/inputs/`, and that run folder when it is then empty. Leaves everything when the
 * run folder has a state.json: the engine made a run, which may still be resumed from these inputs.
 */
export async function removeRunInputs(ctx: AppContext, ws: Workspace, runId: string): Promise<void> {
  const runDir = path.join(ws.path, RUNS_DIR, runId);
  if (existsSync(path.join(runDir, "state.json"))) return;
  await rm(inputsDirOf(ctx.config.dataDir, runId), { recursive: true, force: true });
  await rm(path.join(runDir, "inputs"), { recursive: true, force: true });
  await rmdir(runDir).catch(() => undefined);
}
