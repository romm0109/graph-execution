// Client copies of the graph-manager API shapes. Tasks that add server fields add them here as optional fields.

/** `GET /api/runs` → `{ runs }` (src/server/runs.ts). */
export interface RunSummary {
  workspaceId: string;
  type: "run" | "suite";
  id: string;
  status: string;
  kind: string;
  live: boolean;
  viewUrl?: string;
  createdAt?: string;
  provider?: string;
  taskCounts?: Record<string, number>;
  /** The PR/MR graph-manager opened from this run. */
  pr?: { url: string; number: number; forge: "github" | "gitlab" };
  /** A short reason for a failed or aborted run, e.g. "validation failed". */
  failure?: string;
}

/** `GET /api/workspaces/:id/inspect` (src/server/routes/inspect.ts). */
export interface WorkspaceInspection {
  branch: string;
  changes: number;
  tasksDir?: { exists: boolean; taskFiles: number };
  spec?: { exists: boolean };
}

export type TerminalStatus = "working" | "idle" | "exited";

/** `GET /api/terminals` → `{ terminals }` (src/server/terminals.ts). */
export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  status: TerminalStatus;
  exitCode?: number;
  createdAt: string;
  lastOutputAt?: string;
  /** The foreground process name, e.g. `bash` or `node`; absent once exited. */
  process?: string;
  /** While working: when the current output burst started. */
  workingSince?: string;
}

/** `GET /api/workspaces` → `{ workspaces, root? }` (src/server/routes/workspaces.ts). */
export interface WorkspaceEntry {
  id: string;
  forge: string;
  fullPath: string;
  path: string;
  branch: string;
  dirty: boolean;
  /** Lines of `git status --porcelain` outside `.graph-execution/`. */
  changes?: number;
  remoteUrl: string;
}

/** A background clone: `POST /api/workspaces` → 202 `{ job }`, `GET /api/workspaces/clones` → `{ jobs }`. */
export interface CloneJob {
  id: string;
  forge: "github" | "gitlab";
  fullPath: string;
  status: "running" | "done" | "failed";
  /** 0..1 */
  progress?: number;
  /** The last progress line of git, e.g. "Receiving objects: 58% (1204/2071)". */
  phase?: string;
  error?: string;
  workspace?: WorkspaceEntry;
  startedAt: string;
  endedAt?: string;
}

/** `GET /api/forges/:forge/repos?q=` → `{ repos }` (src/server/forges.ts `ForgeRepo`). */
export interface ForgeRepo {
  fullPath: string;
  name: string;
  defaultBranch?: string;
  cloneUrl?: string;
  private: boolean;
  webUrl: string;
}

/** `GET /api/forges` (src/server/routes/forges.ts). */
export interface ForgesInfo {
  /** `apiUrl`: the configured GitHub API URL. `tokenEnd`: the token's last 4 characters (absent for tokens of 4 characters or fewer). */
  github: { connected: boolean; login?: string; apiUrl?: string; tokenEnd?: string };
  /** `apiUrl` is the stored base URL. */
  gitlab: { connected: boolean; login?: string; baseUrl?: string; apiUrl?: string; tokenEnd?: string };
}
