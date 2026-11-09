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
}

/** `GET /api/workspaces/:id/inspect` (src/server/routes/inspect.ts). */
export interface WorkspaceInspection {
  branch: string;
  changes: number;
  tasksDir?: { exists: boolean; taskFiles: number };
  spec?: { exists: boolean };
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
  workspaceId: string;
  agent?: string;
  terminalTitle?: string;
  createdAt: string;
  prefill: { tasksDir: string; spec: string; provider?: string; options?: Record<string, unknown> };
}
