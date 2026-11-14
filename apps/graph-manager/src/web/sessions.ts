// Repo sessions in the web UI (docs/prd/hosted-sessions.md): labels, the default branch name and the sidebar count.

import type { RepoRef, SessionInfo, SessionState, WorkspaceEntry } from "./types";

/** `octo/hello`. */
export function repoPath(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** The project's name for a project session, else the repository's path. */
export function sessionLabel(s: SessionInfo, projects: { id: string; name: string }[]): string {
  if (s.projectId) return projects.find((p) => p.id === s.projectId)?.name ?? s.projectId;
  return repoPath(s.repo);
}

const pad = (n: number) => String(n).padStart(2, "0");
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The server's default branch name: `gm/<userId>-<yyyymmdd>-<4 chars of [a-z0-9]>`, with the local date. */
export function defaultBranchName(userId: string, now: Date, rand: () => number = Math.random): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let tail = "";
  for (let i = 0; i < 4; i++) tail += CHARS[Math.min(CHARS.length - 1, Math.floor(rand() * CHARS.length))];
  return `gm/${userId}-${date}-${tail}`;
}

export type StateLabel = "starting" | "live" | "saving" | "asking" | "save-failed";

/** The state as the sidebar shows it: `ending` reads as `saving`. */
export function stateLabel(state: SessionState): StateLabel {
  return state === "ending" ? "saving" : state;
}

/** "2 of 3 repositories open" when a limit is set. */
export function countLine(open: number, limit: number | null): string | undefined {
  if (limit === null || limit === undefined) return undefined;
  return `${open} of ${limit} repositories open`;
}

/**
 * One workspace entry per session, for the pages that list workspaces (Runs filter, Start run, agent requests). The
 * clone's dirty state is not known here: `fromSession` says so (Runs then counts an applied run as ready for PR).
 */
export function workspacesFromSessions(sessions: SessionInfo[]): WorkspaceEntry[] {
  const seen = new Set<string>();
  const out: WorkspaceEntry[] = [];
  for (const s of sessions) {
    if (!s.workspaceId || seen.has(s.workspaceId)) continue;
    seen.add(s.workspaceId);
    out.push({
      id: s.workspaceId,
      forge: s.projectId ? "project" : s.repo.forge,
      fullPath: repoPath(s.repo),
      path: "",
      branch: s.branch,
      dirty: false,
      remoteUrl: "",
      fromSession: true,
    });
  }
  return out;
}

/** `github~octo~hello` → the repository; `github~group~sub~name` keeps the owner's subgroups. Undefined for other ids. */
export function repoOfWorkspace(id: string): RepoRef | undefined {
  const parts = id.split("~");
  const forge = parts[0];
  if ((forge !== "github" && forge !== "gitlab") || parts.length < 3 || parts.some((p) => p === "")) return undefined;
  return { forge, owner: parts.slice(1, -1).join("/"), name: parts[parts.length - 1]! };
}
