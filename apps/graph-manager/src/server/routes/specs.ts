import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { taskTitle } from "../runs.js";
import type { WorkspaceHost } from "../host/types.js";
import type { User } from "../identity.js";
import { isRepoId, resolveWorkspace, type Workspace } from "../workspaces.js";

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

/** The `.md` files directly in `<workspace>/docs/prd/`, newest first; symlinks and subfolders are left out. */
export async function listSpecs(host: WorkspaceHost, wsId: string): Promise<SpecEntry[]> {
  const names = (await host.listFiles(wsId, SPECS_DIR, { glob: "*" })).filter((n) => /\.md$/i.test(n));
  const specs: SpecEntry[] = [];
  for (const name of names) {
    const rel = `${SPECS_DIR}/${name}`;
    const [st, text] = await Promise.all([host.stat(wsId, rel), host.readFile(wsId, rel)]);
    // Removed between the listing and the read: not listed.
    if (!st || st.kind !== "file" || st.symlink || text === undefined) continue;
    specs.push({
      path: rel,
      name,
      title: taskTitle(Buffer.from(text).subarray(0, TITLE_BYTES).toString("utf8")) ?? name.replace(/\.md$/i, ""),
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
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

/**
 * Why `rel` (which `stat` does not find) is missing: 400 when one of its folders is a symlink that does not resolve to
 * a folder inside the workspace, else 404.
 */
async function missingStatus(host: WorkspaceHost, wsId: string, rel: string): Promise<400 | 404> {
  const parts = rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const st = await host.stat(wsId, parts.slice(0, i).join("/"));
    if (!st) return 404;
    if (st.kind !== "dir") return 400;
  }
  return 404;
}

/**
 * The host of a repository workspace of `user`: the host of their session on it (a container for Docker or hosted
 * sessions, where the clone is not on this server's disk), else this server's host when the clone is here.
 * Undefined (answer 404) for an id that is no repository, a workspace not theirs, or a local workspace with no clone.
 */
export async function workspaceHostOf(ctx: AppContext, user: User, id: string): Promise<{ host: WorkspaceHost; ws?: Workspace } | undefined> {
  if (!isRepoId(id) || !(await ctx.sessions.ownsWorkspace(user, id))) return undefined;
  const host = await ctx.hostFor(id, user);
  if (host !== ctx.localHost) return { host };
  const ws = resolveWorkspace(ctx.config.workspacesDir, id);
  return ws ? { host, ws } : undefined;
}

export async function specRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/specs", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const found = await workspaceHostOf(ctx, req.user, req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown workspace" });
    return { specs: await listSpecs(found.host, req.params.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/workspaces/:id/specs/file", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const found = await workspaceHostOf(ctx, req.user, req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown workspace" });
    const rel = typeof req.query.path === "string" ? normalizeSpecPath(req.query.path) : undefined;
    if (rel === undefined) return reply.code(400).send({ error: INVALID_PATH });
    const { host } = found;
    const ws = { id: req.params.id };
    // A symlink is refused whatever it points at (the list skips them too), so the answer never tells whether a
    // path outside the workspace exists.
    const st = await host.stat(ws.id, rel);
    if (!st) {
      const status = await missingStatus(host, ws.id, rel);
      return reply.code(status).send({ error: status === 400 ? INVALID_PATH : "spec not found" });
    }
    if (st.symlink || st.kind !== "file") return reply.code(400).send({ error: INVALID_PATH });
    if (st.size > MAX_SPEC_BYTES) return reply.code(413).send({ error: "spec is larger than 1 MiB" });
    const text = await host.readFile(ws.id, rel);
    if (text === undefined) return reply.code(404).send({ error: "spec not found" });
    return { path: rel, text, mtimeMs: st.mtimeMs };
  });
}
