// The pure parts of starting a run in a sandbox container (KAN-88): login files, env, mounts, the create body.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { ContainerInfo } from "./docker.js";
import { containerRoot } from "./sandbox-paths.js";
import type { TarEntry } from "./tar.js";
import type { Workspace } from "./workspaces.js";

/** A failed sandbox start: the HTTP status and, when the container ran, its last log lines. */
export class SandboxError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly output?: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/** The HOME of a sandbox container. */
export const SANDBOX_HOME = "/home/sandbox";
/** The Debian default PATH: a sandbox image's PATH when its image inspect names none. */
export const DEFAULT_IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The PATH of a sandbox container: the tools, the provider CLIs, then the image's own PATH. Docker does not expand
 * `$PATH` in `Env`, so the image's PATH is read with image inspect and passed in here.
 */
export function sandboxPath(imagePath?: string): string {
  return `/opt/gm-tools/bin:/opt/gm-clis/bin:${imagePath || DEFAULT_IMAGE_PATH}`;
}
const ENGINE_CLI = "/opt/gm-tools/graph-execution/dist/cli.js";

/** The login files of each provider, relative to HOME. A trailing `/` is a folder, copied recursively. */
export const LOGIN_FILES: Record<string, string[]> = {
  claude: [".claude/.credentials.json", ".claude.json"],
  codex: [".codex/auth.json", ".codex/config.toml"],
  opencode: [".local/share/opencode/auth.json", ".config/opencode/"],
  qwen: [".qwen/oauth_creds.json", ".qwen/settings.json"],
  fake: [],
};

/** The env keys that log a provider in without files. */
export const LOGIN_KEYS: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
  opencode: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  qwen: ["OPENAI_API_KEY"],
  fake: [],
};

async function isFile(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isFile())
    .catch(() => false);
}

async function isDir(p: string): Promise<boolean> {
  return stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/** Every file under `dir` (relative paths with "/"), symlinks skipped. */
async function walk(dir: string, rel = ""): Promise<{ files: string[]; dirs: string[] }> {
  const out = { files: [] as string[], dirs: [] as string[] };
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      out.dirs.push(r);
      const sub = await walk(dir, r);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
    } else if (e.isFile()) out.files.push(r);
  }
  return out;
}

/**
 * The tar entries of the providers' login files that exist under `home`, at `home/sandbox/<rel>`, with their parent
 * folders (0700; files 0600). `home/sandbox/` is always there; `home/` itself is not, so the image's /home keeps its
 * owner and mode (Docker applies an entry's metadata to an existing folder). A provider (other than `fake`) with no
 * file and no login key in `env` throws a 400.
 */
export async function loginEntries(providers: string[], home: string, env: NodeJS.ProcessEnv): Promise<TarEntry[]> {
  const dirs = new Set<string>(["home/sandbox"]);
  const files = new Map<string, string>(); // tar path → host path
  const addDirsOf = (rel: string): void => {
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(`home/sandbox/${parts.slice(0, i).join("/")}`);
  };
  for (const p of new Set(providers)) {
    const wanted = LOGIN_FILES[p] ?? [];
    let found = 0;
    for (const rel of wanted) {
      if (rel.endsWith("/")) {
        const folder = rel.slice(0, -1);
        const src = path.join(home, folder);
        if (!(await isDir(src))) continue;
        found++;
        addDirsOf(`${folder}/x`);
        const tree = await walk(src);
        for (const d of tree.dirs) dirs.add(`home/sandbox/${folder}/${d}`);
        for (const f of tree.files) {
          addDirsOf(`${folder}/${f}`);
          files.set(`home/sandbox/${folder}/${f}`, path.join(src, f));
        }
      } else {
        const src = path.join(home, rel);
        if (!(await isFile(src))) continue;
        found++;
        addDirsOf(rel);
        files.set(`home/sandbox/${rel}`, src);
      }
    }
    const keys = LOGIN_KEYS[p] ?? [];
    if (p !== "fake" && found === 0 && !keys.some((k) => (env[k] ?? "") !== "")) {
      throw new SandboxError(400, `no ${p} login to copy into the sandbox: log in once in a terminal, or set ${keys[0] ?? "an API key"}`);
    }
  }
  const entries: TarEntry[] = [...dirs].sort().map((d) => ({ path: `${d}/`, dir: true, mode: 0o700 }));
  for (const [tarPath, src] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    entries.push({ path: tarPath, content: await readFile(src), mode: 0o600 });
  }
  return entries;
}

/** Variables passed from graph-manager's env into a sandbox (besides the public `GRAPH_EXECUTION_*`). */
const PASSED = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "TZ",
  "LANG",
];
/** `GRAPH_EXECUTION_*` variables that tie a run to its launcher or folder: never passed, some set below. */
const INTERNAL = new Set(
  ["RUNS_ROOT", "READY_FILE", "TASK_NAME", "RUN_ID", "HANDOFF", "TAKE_LOCK_FROM", "SANDBOX", "SANDBOX_IMAGE", "WEB_HOST", "WEB_PORT", "WEB_TOKEN"].map(
    (n) => `GRAPH_EXECUTION_${n}`,
  ),
);
const IDENTITY = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

/** The `Env` of a sandbox container. Never any `GM_*` (the password), nor graph-manager's HOME, PATH or HOSTNAME. */
export function sandboxEnv(
  base: NodeJS.ProcessEnv,
  p: {
    runId: string;
    /** The run folder as the container sees it. */
    runDir: string;
    image: string;
    token: string;
    takeLockFrom?: string;
    gitIdentity?: Record<string, string>;
    /** The PATH of the sandbox's image (image inspect); the Debian default when absent. */
    imagePath?: string;
    /** git settings passed as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<i>` / `GIT_CONFIG_VALUE_<i>` (a Windows host). */
    gitConfig?: readonly (readonly [string, string])[];
  },
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (PASSED.includes(k) || (k.startsWith("GRAPH_EXECUTION_") && !INTERNAL.has(k))) out.push(`${k}=${v}`);
  }
  for (const k of IDENTITY) {
    const v = p.gitIdentity?.[k];
    if (v !== undefined && base[k] === undefined) out.push(`${k}=${v}`);
  }
  out.push(
    "GRAPH_EXECUTION_SANDBOX=1",
    `GRAPH_EXECUTION_SANDBOX_IMAGE=${p.image}`,
    `GRAPH_EXECUTION_RUN_ID=${p.runId}`,
    "GRAPH_EXECUTION_WEB_HOST=0.0.0.0",
    "GRAPH_EXECUTION_WEB_PORT=7600",
    // Every sandbox shares gm-sandbox: without this secret, one sandbox could drive another one's run page.
    `GRAPH_EXECUTION_WEB_TOKEN=${p.token}`,
    `GRAPH_EXECUTION_READY_FILE=${path.posix.join(p.runDir, ".ready.json")}`,
    `HOME=${SANDBOX_HOME}`,
    `PATH=${sandboxPath(p.imagePath)}`,
  );
  if (p.takeLockFrom) out.push(`GRAPH_EXECUTION_TAKE_LOCK_FROM=${p.takeLockFrom}`);
  if (p.gitConfig && p.gitConfig.length > 0) {
    out.push(`GIT_CONFIG_COUNT=${p.gitConfig.length}`);
    p.gitConfig.forEach(([key, value], i) => out.push(`GIT_CONFIG_KEY_${i}=${key}`, `GIT_CONFIG_VALUE_${i}=${value}`));
  }
  return out;
}

/** One git setting of the checkout in `cwd`; undefined when it is unset or empty. */
async function gitConfigGet(cwd: string, key: string): Promise<string | undefined> {
  const res = await execa("git", ["config", "--get", key], { cwd, reject: false });
  const v = typeof res.stdout === "string" ? res.stdout.trim() : "";
  return res.exitCode === 0 && v !== "" ? v : undefined;
}

/** The workspace's git identity as `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (the sandbox HOME has no git config). */
export async function gitIdentity(cwd: string): Promise<Record<string, string>> {
  const [name, email] = await Promise.all([gitConfigGet(cwd, "user.name"), gitConfigGet(cwd, "user.email")]);
  const out: Record<string, string> = {};
  if (name !== undefined) {
    out.GIT_AUTHOR_NAME = name;
    out.GIT_COMMITTER_NAME = name;
  }
  if (email !== undefined) {
    out.GIT_AUTHOR_EMAIL = email;
    out.GIT_COMMITTER_EMAIL = email;
  }
  return out;
}

/** The git settings of a sandbox on a Windows host, for GIT_CONFIG_*: the mounted files look foreign-owned and executable. */
export async function windowsGitConfig(cwd: string): Promise<[string, string][]> {
  const out: [string, string][] = [
    ["safe.directory", "*"],
    ["core.filemode", "false"],
  ];
  // The host's line-ending setting, so the container's git sees the checkout as the host's git left it.
  const autocrlf = await gitConfigGet(cwd, "core.autocrlf");
  if (autocrlf !== undefined) out.push(["core.autocrlf", autocrlf]);
  return out;
}

export type WorkspaceMount =
  | { Type: "bind"; Source: string; Target: string }
  | { Type: "volume"; Source: string; Target: string; VolumeOptions: { Subpath: string } };

/**
 * The Docker mount of one workspace, read-write at `containerRoot`: the same absolute path as in graph-manager
 * (worktrees and state.json store absolute paths), or `/workspaces/<rel>` on a Windows host, whose paths cannot be
 * mount targets. Other workspaces are never visible.
 */
export function workspaceMount(
  ws: Workspace,
  workspacesDir: string,
  self: ContainerInfo | undefined,
  override?: string,
  platform: NodeJS.Platform = process.platform,
): WorkspaceMount {
  const target = containerRoot(ws, platform);
  if (override) {
    // A host path is a bind source in the host's own form (`C:\\…` on Windows); anything else is a volume name.
    const p = platform === "win32" ? path.win32 : path.posix;
    if (p.isAbsolute(override)) return { Type: "bind", Source: p.join(override, ws.rel), Target: target };
    return { Type: "volume", Source: override, Target: target, VolumeOptions: { Subpath: ws.rel } };
  }
  if (self) {
    const dir = path.posix.resolve(workspacesDir); // graph-manager runs in a Linux container here
    const m = self.Mounts?.find((x) => x.Destination === dir);
    if (m?.Type === "volume" && m.Name) return { Type: "volume", Source: m.Name, Target: target, VolumeOptions: { Subpath: ws.rel } };
    if (m?.Type === "bind") return { Type: "bind", Source: path.posix.join(m.Source, ws.rel), Target: target };
    throw new SandboxError(400, "graph-manager's workspaces folder is not a Docker mount: set GM_SANDBOX_WORKSPACES_SOURCE");
  }
  return { Type: "bind", Source: ws.path, Target: target };
}

/**
 * The extra mounts of a sandboxed project run: each repo's workspace at its own `containerRoot` (its host path, or
 * `/workspaces/<rel>` on a Windows host), mounted like the project folder itself (`workspaceMount`). Off Windows the
 * project's `repos/<name>` symlinks point at those host paths, so they resolve in the container as they are.
 * On a Windows host they are junctions with Windows targets a Linux container cannot follow: the same source is also
 * mounted at `<project mount>/<link>` (`links[i]`: the repo's path in project.json, such as `repos/api`), over the
 * junction. Docker Desktop's handling of a mount target that is a junction inside another bind mount is not covered
 * by CI (no Docker on its Windows runners): the tests only assert the mount list.
 */
export function repoMounts(
  home: Workspace,
  repos: readonly Workspace[],
  links: readonly string[],
  workspacesDir: string,
  self: ContainerInfo | undefined,
  override?: string,
  platform: NodeJS.Platform = process.platform,
): WorkspaceMount[] {
  const out: WorkspaceMount[] = [];
  for (const [i, repo] of repos.entries()) {
    const m = workspaceMount(repo, workspacesDir, self, override, platform);
    out.push(m);
    const link = links[i];
    if (platform === "win32" && link !== undefined) {
      out.push({ ...m, Target: path.posix.join(containerRoot(home, platform), link.replaceAll("\\", "/")) });
    }
  }
  return out;
}

export interface ContainerBodyParams {
  image: string;
  hostname: string;
  owner: { uid: number; gid: number };
  env: string[];
  /** Engine arguments without `--web`; `--web-serve` is appended. */
  args: string[];
  cwd: string;
  runId: string;
  workspaceId: string;
  limits: { cpus: number; memoryMb: number; pids: number };
  mounts: object[];
  /**
   * Publish the run page's port on the host's 127.0.0.1 (a free port Docker picks). Needed when graph-manager runs on
   * the host: Docker Desktop (macOS, Windows) does not route the host to container IPs on gm-sandbox.
   */
  publishPort?: number;
}

/** The `POST /containers/create` body of a sandbox. */
export function containerBody(p: ContainerBodyParams): Record<string, unknown> {
  return {
    Image: p.image,
    Hostname: p.hostname,
    User: `${p.owner.uid}:${p.owner.gid}`,
    Env: p.env,
    Cmd: ["node", ENGINE_CLI, ...p.args, "--web-serve"],
    WorkingDir: p.cwd,
    Labels: { "gm.run": p.runId, "gm.workspace": p.workspaceId },
    ...(p.publishPort !== undefined ? { ExposedPorts: { [`${p.publishPort}/tcp`]: {} } } : {}),
    HostConfig: {
      Init: true,
      NanoCpus: Math.round(p.limits.cpus * 1e9),
      Memory: p.limits.memoryMb * 1024 * 1024,
      PidsLimit: p.limits.pids,
      SecurityOpt: ["no-new-privileges"],
      // Not AutoRemove: when a start fails, graph-manager reads the container's logs (an auto-removed container has
      // none left), then removes it itself; the watcher removes it when the engine exits, and init() reconciles
      // containers that exited while graph-manager was down.
      AutoRemove: false,
      // No tmpfs at /home/sandbox: a tmpfs is mounted at start, over the login files putArchive copied in before
      // start. The home lives in the container's own layer instead, which is deleted with the container.
      NetworkMode: "gm-sandbox",
      Mounts: p.mounts,
      ...(p.publishPort !== undefined ? { PortBindings: { [`${p.publishPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] } } : {}),
    },
  };
}
