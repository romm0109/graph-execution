import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { taskTitle } from "../runs.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";
import { insideWorkspace } from "./runs.js";

/** The folder of a workspace whose specs the UI watches; its subfolders (`done/`, …) are not listed. */
export const SPECS_DIR = "docs/prd";
/** The largest spec the file route returns. */
export const MAX_SPEC_BYTES = 1024 * 1024;
/** How much of a spec is read to find its title. */
const TITLE_BYTES = 64 * 1024;

export interface SpecEntry {
  /** Relative to the workspace, with `/`: `docs/prd/<name>`. */
  path: string;
  name: string;
  title: string;
  mtimeMs: number;
  size: number;
}

const INVALID_PATH = "path: must be a .md file in docs/prd/";

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** True when `dir` resolves (symlinks followed) to the workspace root or inside it. */
async function realInside(ws: Workspace, dir: string): Promise<boolean> {
  const [real, root] = await Promise.all([realpath(dir), realpath(ws.path)]);
  return real === root || real.startsWith(root + path.sep);
}

/** The `.md` files directly in `<workspace>/docs/prd/`, newest first; symlinks and subfolders are left out. */
export async function listSpecs(ws: Workspace): Promise<SpecEntry[]> {
  const dir = path.join(ws.path, SPECS_DIR);
  let entries;
  try {
    if (!(await realInside(ws, dir))) return [];
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  const specs: SpecEntry[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink() || !e.name.toLowerCase().endsWith(".md")) continue;
    const file = path.join(dir, e.name);
    try {
      const st = await stat(file);
      const head = await readHead(file, Math.min(TITLE_BYTES, st.size));
      specs.push({
        path: `${SPECS_DIR}/${e.name}`,
        name: e.name,
        title: taskTitle(head) ?? e.name.replace(/\.md$/i, ""),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // Removed between readdir and stat: not listed.
    }
  }
  return specs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

/** `rel` normalized to `docs/prd/<name>.md` (one segment, no `..`), or undefined when it is not of that form. */
export function normalizeSpecPath(rel: string): string | undefined {
  if (rel === "" || rel.includes("\0") || path.isAbsolute(rel) || path.posix.isAbsolute(rel.replaceAll("\\", "/"))) return undefined;
  const raw = rel.replaceAll("\\", "/");
  if (raw.split("/").includes("..")) return undefined;
  const norm = path.posix.normalize(raw);
  const prefix = `${SPECS_DIR}/`;
  if (!norm.startsWith(prefix)) return undefined;
  const name = norm.slice(prefix.length);
  if (name === "" || name.includes("/") || name === "." || !name.toLowerCase().endsWith(".md") || name.length <= 3) return undefined;
  return norm;
}

/** The absolute path of a spec of the workspace, or undefined when `rel` is not one or escapes the workspace. */
export function specFileOf(ws: Workspace, rel: string): string | undefined {
  const norm = normalizeSpecPath(rel);
  return norm === undefined ? undefined : insideWorkspace(ws, norm);
}

export async function specRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/specs", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    return { specs: await listSpecs(ws) };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/workspaces/:id/specs/file", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.id);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const rel = typeof req.query.path === "string" ? normalizeSpecPath(req.query.path) : undefined;
    if (rel === undefined) return reply.code(400).send({ error: INVALID_PATH });
    // A symlink is refused whatever it points at (the list skips them too), so the answer never tells whether a
    // path outside the workspace exists.
    let link;
    try {
      link = await lstat(path.resolve(ws.path, rel));
    } catch {
      return reply.code(404).send({ error: "spec not found" });
    }
    if (link.isSymbolicLink()) return reply.code(400).send({ error: INVALID_PATH });
    const file = specFileOf(ws, rel);
    if (!file) return reply.code(400).send({ error: INVALID_PATH });
    let st;
    try {
      st = await stat(file);
    } catch {
      return reply.code(404).send({ error: "spec not found" });
    }
    if (!st.isFile()) return reply.code(400).send({ error: INVALID_PATH });
    if (st.size > MAX_SPEC_BYTES) return reply.code(413).send({ error: "spec is larger than 1 MiB" });
    const text = await readHead(file, st.size);
    return { path: rel, text, mtimeMs: st.mtimeMs };
  });
}
