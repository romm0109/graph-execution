// `list_graphs` (docs/prd/agent-supervisor.md, KAN-91): the task folders under .agents/tasks/ with their spec.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { countTaskFiles } from "../routes/inspect.js";
import { insideWorkspace } from "../routes/runs.js";
import { SPECS_DIR } from "../routes/specs.js";
import type { Workspace } from "../workspaces.js";
import { isToolResult, requireWorkspace, table, workspaceRel } from "./run-helpers.js";
import { defineTool } from "./types.js";

const TASKS_ROOT = ".agents/tasks";
const MAX_DEPTH = 8;
const MAX_FOLDERS = 500;

async function isFile(f: string): Promise<boolean> {
  try {
    return (await stat(f)).isFile();
  } catch {
    return false;
  }
}

/** `root` and its real subfolders (no symlinks), breadth first, bounded in depth and count. */
async function folders(root: string): Promise<string[]> {
  const out: string[] = [];
  let level = [root];
  for (let depth = 0; level.length > 0 && depth <= MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (out.length >= MAX_FOLDERS) return out;
      out.push(dir);
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !e.isSymbolicLink()) next.push(path.join(dir, e.name));
        }
      } catch {
        // unreadable: listed (if it has tasks), not descended
      }
    }
    level = next;
  }
  return out;
}

async function specOf(ws: Workspace, name: string): Promise<string> {
  for (const rel of [`${SPECS_DIR}/${name}.md`, `${SPECS_DIR}/done/${name}.md`]) {
    const full = insideWorkspace(ws, rel);
    if (full && (await isFile(full))) return rel;
  }
  return "";
}

export const listGraphsTool = defineTool({
  name: "list_graphs",
  description:
    "List the graph-execution task folders of this workspace (under .agents/tasks/), with their number of task files and the matching spec in docs/prd/ or docs/prd/done/.",
  input: z.object({}),
  async run(_i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const none = { text: `No task folders in this workspace (none under ${TASKS_ROOT}/).` };
    const root = insideWorkspace(ws, TASKS_ROOT);
    if (!root) return none;
    const rows: string[][] = [];
    for (const dir of await folders(root)) {
      const n = await countTaskFiles(dir);
      if (!n) continue;
      rows.push([workspaceRel(ws, dir), String(n), await specOf(ws, path.basename(dir))]);
    }
    if (rows.length === 0) return none;
    rows.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
    return { text: table(["tasksDir", "tasks", "spec"], rows) };
  },
});
