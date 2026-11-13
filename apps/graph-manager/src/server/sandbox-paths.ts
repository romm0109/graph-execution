// Where a workspace lives inside its sandbox container, and the mapping between host and container paths.
// Pure: no file access, and the platform is always a parameter, so the results are the same on every OS.
// Only a Windows host needs a mapping (its paths cannot be mount targets); elsewhere the two forms are equal.
import path from "node:path";
import { RUN_VALUE_OPTIONS } from "graph-execution/api";
import type { Workspace } from "./workspaces.js";

const VALUE_OPTIONS = new Set(RUN_VALUE_OPTIONS);
/** The options of the run command (and `suite --project`) whose value is a path. */
const PATH_OPTIONS = new Set(["--spec", "--reviewers", "--project"]);

const dropTrailing = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
/** A host path with `/` separators, `.` and `..` resolved, no trailing slash. Never `resolve`: it would add a drive. */
const hostForm = (p: string): string => dropTrailing(path.win32.normalize(p).replaceAll("\\", "/"));

/** The workspace's folder as its sandbox container sees it: its own path, or `/workspaces/<rel>` on a Windows host. */
export function containerRoot(ws: Workspace, platform: NodeJS.Platform): string {
  return platform === "win32" ? `/workspaces/${ws.rel}` : ws.path;
}

/** A host path in the container's form. Paths outside the workspace are returned as given. */
export function toContainer(ws: Workspace, hostPath: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return hostPath;
  const root = hostForm(ws.path);
  const p = hostForm(hostPath);
  // Windows file names are case-insensitive; the rest keeps its own case for the container's file system.
  if (p.toLowerCase() === root.toLowerCase()) return containerRoot(ws, platform);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (p.toLowerCase().startsWith(prefix.toLowerCase())) return `${containerRoot(ws, platform)}/${p.slice(prefix.length)}`;
  return hostPath;
}

/** A container path in the host's form. Paths outside the workspace's mount are returned as given. */
export function toHost(ws: Workspace, containerPath: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return containerPath;
  const root = containerRoot(ws, platform);
  const p = dropTrailing(path.posix.normalize(containerPath));
  if (p === root) return ws.path;
  if (!p.startsWith(`${root}/`)) return containerPath;
  const sep = ws.path.includes("\\") ? "\\" : "/";
  const base = ws.path.endsWith(sep) ? ws.path.slice(0, -1) : ws.path;
  return [base, ...p.slice(root.length + 1).split("/")].join(sep);
}

/**
 * The engine's arguments for the container. On a Windows host the path arguments (the tasks folder, `--spec`,
 * `--reviewers`) are mapped: absolute ones through `toContainer`, relative ones get `/` separators.
 */
export function toContainerArgs(ws: Workspace, args: readonly string[], platform: NodeJS.Platform): string[] {
  const out = [...args];
  if (platform !== "win32") return out;
  const map = (v: string): string => (path.win32.isAbsolute(v) ? toContainer(ws, v, platform) : v.replaceAll("\\", "/"));
  let first = true;
  const positional = (i: number): void => {
    if (first) out[i] = map(out[i]!);
    first = false;
  };
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    if (a === "--") {
      if (i + 1 < out.length) positional(i + 1);
      break;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const name = a.slice(0, eq);
      if (PATH_OPTIONS.has(name)) out[i] = `${name}=${map(a.slice(eq + 1))}`;
    } else if (VALUE_OPTIONS.has(a) || PATH_OPTIONS.has(a)) {
      i++;
      if (PATH_OPTIONS.has(a) && i < out.length) out[i] = map(out[i]!);
    } else if (!a.startsWith("-")) positional(i);
  }
  return out;
}
