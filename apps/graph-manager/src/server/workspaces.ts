import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** A git checkout under the workspaces dir, at `<forge>/<owner>/<repo>` (GitLab groups may nest). */
export interface Workspace {
  /** `rel` with "/" replaced by "~", e.g. `github~octo~hello`. */
  id: string;
  /** Absolute path of the checkout. */
  path: string;
  /** Path relative to the workspaces dir, with "/" separators. */
  rel: string;
  /** First segment of `rel`, e.g. `github`. */
  forge: string;
  /** The rest of `rel`, e.g. `octo/hello`. */
  fullPath: string;
}

const MAX_DEPTH = 5;

function toWorkspace(root: string, rel: string): Workspace {
  const parts = rel.split("/");
  return {
    id: parts.join("~"),
    path: path.join(path.resolve(root), ...parts),
    rel,
    forge: parts[0] ?? "",
    fullPath: parts.slice(1).join("/"),
  };
}

/** Every directory up to 5 levels below `root` that contains `.git`, sorted by id. It doesn't descend into a workspace. */
export async function listWorkspaces(root: string): Promise<Workspace[]> {
  const found: Workspace[] = [];
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    if (rel.length > 0 && existsSync(path.join(dir, ".git"))) {
      found.push(toWorkspace(root, rel.join("/")));
      return;
    }
    if (rel.length >= MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      await walk(path.join(dir, e.name), [...rel, e.name]);
    }
  };
  await walk(path.resolve(root), []);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** The workspace with this id, or undefined when the id is unsafe (`..`, absolute, empty parts) or its dir has no `.git`. */
export function resolveWorkspace(root: string, id: string): Workspace | undefined {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) return undefined;
  const parts = id.split("~");
  if (parts.length < 2 || parts.length > MAX_DEPTH) return undefined;
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".") || path.isAbsolute(p))) return undefined;
  const ws = toWorkspace(root, parts.join("/"));
  if (!insideWorkspaces(root, ws.path)) return undefined;
  try {
    if (!statSync(ws.path).isDirectory() || !existsSync(path.join(ws.path, ".git"))) return undefined;
  } catch {
    return undefined;
  }
  return ws;
}

/** `realpathSync` of `p`; for a path that does not exist (yet), that of its nearest existing ancestor plus the rest. */
function real(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(real(parent), path.basename(abs));
  }
}

/** True when `p` is strictly inside `root`, after resolving symlinks (so a link inside `root` cannot point out of it). */
export function insideWorkspaces(root: string, p: string): boolean {
  if (!path.resolve(p).startsWith(path.resolve(root) + path.sep)) return false;
  return real(p).startsWith(real(root) + path.sep);
}
