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
  /**
   * Set for a sandboxed run: while its container exists (`running`), or from state.json's `sandbox` once it is gone
   * (`gone: true`, with the image it ran in).
   */
  sandbox?: { running: boolean; image?: string; gone?: true };
  /** Set for a run of a project (`workspaceId` is then `project~<id>`); `repos` are the names under `repos/`. */
  project?: { id: string; name: string; repos: string[] };
  /** Set when the run comes from the run archive (its workspace or session is gone): read-only. */
  archived?: true;
}

/** `GET /api/projects/:id/inspect` (src/server/routes/inspect.ts): what the Start run drawer checks of a project. */
export interface ProjectInspection {
  id: string;
  name: string;
  contract: boolean;
  testPlan: boolean;
  repos: {
    name: string;
    workspaceId?: string;
    fullPath?: string;
    branch?: string;
    changes?: number;
    /** `specs/<name>.md` is a file. */
    spec: boolean;
    /** Task files in `tasks/<name>/`; absent when there is no such folder. */
    taskFiles?: number;
  }[];
}

/** `GET /api/workspaces/:id/inspect` (src/server/routes/inspect.ts). */
export interface WorkspaceInspection {
  branch: string;
  changes: number;
  tasksDir?: { exists: boolean; taskFiles: number };
  spec?: { exists: boolean };
  /** The session runs remotely: each run gets its own container (no "Run in sandbox" toggle). */
  hosted?: boolean;
  /** With `hosted`: the session's repository, `<owner>/<name>`. */
  repo?: string;
}

export type TerminalStatus = "working" | "idle" | "exited";

export type AgentId = "claude" | "codex" | "opencode" | "qwen";

/** `GET /api/agents` → `{ agents }` (src/server/routes/terminals.ts). */
export interface AgentInfo {
  id: AgentId;
  label: string;
  /** The CLI looked up on the PATH, e.g. `claude`. */
  binary?: string;
  installed: boolean;
  /** `inject`: the tools are passed on the command line; `project-config`: a config file is committed in the workspace. */
  connect: "inject" | "project-config";
}

/** `GET /api/terminals` → `{ terminals }` (src/server/terminals.ts). */
export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  /** Set when opened on a project: cwd is the project folder. */
  projectId?: string;
  status: TerminalStatus;
  exitCode?: number;
  createdAt: string;
  lastOutputAt?: string;
  /** The foreground process name, e.g. `bash` or `node`; absent once exited. */
  process?: string;
  /** While working: when the current output burst started. */
  workingSince?: string;
  /** The agent the terminal was opened with, if any. */
  agent?: AgentId;
  /** The repo session the terminal belongs to. */
  sessionId?: string;
}

/** A repository on a forge (src/server/host/types.ts). */
export interface RepoRef {
  forge: "github" | "gitlab";
  owner: string;
  name: string;
  baseUrl?: string;
}

export type SessionState = "starting" | "live" | "asking" | "ending" | "save-failed";

/** One entry of `GET /api/sessions` → `{ sessions, limit }` (src/server/routes/sessions.ts). */
export interface SessionInfo {
  id: string;
  repo: RepoRef;
  projectId?: string;
  /** A project session: all its repositories (`repo` is the first). */
  repos?: RepoRef[];
  workspaceId: string;
  branch: string;
  state: SessionState;
  startedAt: string;
  error?: string;
  terminals: string[];
  /** The uncommitted files, when the server keeps them on an `asking` session. */
  changes?: string[];
}

/** One entry of `GET /api/repos?q=` → `{ repos, forges }`. */
export interface ForgeRepoEntry {
  repo: RepoRef;
  fullPath: string;
  defaultBranch: string;
  private: boolean;
  webUrl: string;
  live: boolean;
  sessionId?: string;
  branch?: string;
}

/** `POST /api/sessions` → 201. */
export interface OpenedSession {
  sessionId: string;
  terminalId: string;
  branch: string;
}

/** `POST /api/sessions/:id/close` → 200. */
export interface CloseResult {
  session: SessionInfo;
  skipped?: string[];
}

/** `GET /api/projects` → `ProjectEntry[]` (src/server/routes/projects.ts): a named group of repositories of one forge. */
export interface ProjectEntry {
  id: string;
  name: string;
  forge: string;
  /** The project's folder, `<workspaces dir>/.projects/<id>`; it exists once a project session has started. */
  path: string;
  createdAt: string;
  /** The repositories, in order (cloned when a project session starts). */
  repos: RepoRef[];
  /** One per repository: its clone's workspace id, `owner/name`, and `repo`: its name under the folder's `repos/`. */
  workspaces: { id: string; fullPath: string; repo: string }[];
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
  /** Built from a repo session (`workspacesFromSessions`): the branch is known, the dirty state is not. */
  fromSession?: true;
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

/** `GET /api/sandbox/status` (KAN-88). */
export interface SandboxStatus {
  available: boolean;
  /** The sandbox images are being built; `available` is false until they are ready. */
  building?: boolean;
  /** While building: the CLIs are ready, so a workspace with its own recipe image can start. */
  clisReady?: boolean;
  reason?: string;
  defaultImage?: string;
}

/** Resource limits of every sandbox container: `GET/PUT /api/settings/sandbox`. */
export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
}

/** The opt-in language toolchains of the sandbox image. */
export type ToolchainId = "python" | "java" | "go" | "rust" | "ruby" | "php" | "cpp";

/** One toolchain of a recipe: whether it is installed and its Dockerfile lines. */
export interface RecipeToolchain {
  id: ToolchainId;
  enabled: boolean;
  snippet: string;
}

/**
 * The recipe of the sandbox image graph-manager builds: base image + toolchains (all 7, in Dockerfile
 * order) + extra Dockerfile lines.
 */
export interface SandboxRecipe {
  base: string;
  toolchains: RecipeToolchain[];
  extraLines: string;
}

/** A toolchain's display name and default snippet, from `GET /api/settings/sandbox`. */
export interface ToolchainInfo {
  id: ToolchainId;
  name: string;
  snippet: string;
}

/** `GET /api/sandbox/build`: the state of the last sandbox image build and its log. */
export interface SandboxBuild {
  state: "idle" | "queued" | "building" | "ready" | "failed";
  step?: "clis" | "image";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  log: string[];
}

/** `GET/PUT /api/settings/sandbox`. */
export interface SandboxSettings {
  limits: SandboxLimits;
  recipe: SandboxRecipe;
  defaultRecipe: SandboxRecipe;
  toolchains: ToolchainInfo[];
  dockerfile: string;
  image: string;
}

/** `POST /api/sandbox/dockerfile`: the Dockerfile and image tag of a recipe, and its validation error if any. */
export interface DockerfilePreview {
  dockerfile: string;
  image: string;
  error?: string;
}

/** Where a workspace's sandbox image comes from: the global recipe, its own recipe, or a ready-made image. */
export type WorkspaceImageSource = "global" | "recipe" | "image";

/** `GET/PUT /api/workspaces/:id/settings`. The PUT answer also carries the workspace's `build`. */
export interface WorkspaceSettings {
  sandbox: boolean;
  source: WorkspaceImageSource;
  image: string | null;
  recipe: SandboxRecipe | null;
  dockerfile: string | null;
  /** The image a sandboxed run of this workspace uses. */
  effectiveImage: string;
  build?: SandboxBuild;
}

/** `GET /api/agent-requests` (src/server/agent-requests.ts). */
export interface AgentRequest {
  id: string;
  kind: "start-run";
  terminalId: string;
  /** `project~<id>` for a request of a project. */
  workspaceId: string;
  projectId?: string;
  agent?: string;
  terminalTitle?: string;
  createdAt: string;
  prefill: { tasksDir?: string; spec?: string; provider?: string; options?: Record<string, unknown> };
}
