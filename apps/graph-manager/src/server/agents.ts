import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execa, execaSync } from "execa";

/**
 * Agent adapters: how graph-manager opens a terminal running a coding agent with graph-manager's MCP server
 * (`graph-manager-mcp`) connected, either by flags/env at launch (`inject`) or by a committed project file
 * (`project-config`). See docs/prd/agent-tools.md, "Agent adapters".
 */

export const AGENT_IDS = ["claude", "codex", "opencode", "qwen"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
/** The MCP server's name in every agent's config. */
export const MCP_NAME = "graph-manager";
/** The command on the terminals' PATH (`writeMcpShim`); on Windows the file there is `graph-manager-mcp.cmd`, see `mcpCommand`. */
export const MCP_COMMAND = "graph-manager-mcp";

/**
 * The name an agent starts the MCP server by: a bare file name found on PATH. An agent spawns it without a shell, so
 * on Windows there is no PATHEXT resolution and the name must carry the `.cmd` of the file `writeMcpShim` writes.
 */
export function mcpCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${MCP_COMMAND}.cmd` : MCP_COMMAND;
}

export interface AgentLaunch {
  argv: string[];
  env?: Record<string, string>;
}

export interface ProjectConfig {
  /** Workspace-relative, "/" separators. */
  file: string;
  /** The config with graph-manager's entry added; other keys kept. */
  apply(json: Record<string, unknown>): Record<string, unknown>;
  /** True when the config already has graph-manager's entry. */
  matches(json: Record<string, unknown>): boolean;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  binary: string;
  connect: "inject" | "project-config";
  /** `major`: the CLI's major version, for an agent whose config differs between versions; asked from the CLI when left out. */
  launch(o: { dataDir: string; platform?: NodeJS.Platform; major?: number }): AgentLaunch;
  projectConfig?: ProjectConfig;
}

/** `<dataDir>/agents/claude-mcp.json`, passed to Claude Code with `--mcp-config`. */
export function claudeMcpConfigPath(dataDir: string): string {
  return path.join(dataDir, "agents", "claude-mcp.json");
}

// The bare name on every platform, Windows included: `.qwen/settings.json` is committed and shared between machines,
// so a `.cmd` name would break it on Linux and macOS, and `matches` compares the entry with `isDeepStrictEqual`.
const QWEN_ENTRY = { command: MCP_COMMAND, trust: true };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The major version `<bin> --version` prints, or undefined when the CLI does not start, prints no version or takes
 * longer than 10 s. Synchronous: it runs once, when an agent terminal is opened.
 */
export function cliMajor(bin: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  try {
    // execa resolves a Windows `.cmd` shim the way the terminal's shell does.
    const res = execaSync(bin, ["--version"], { env, extendEnv: false, reject: false, stdin: "ignore", timeout: 10_000 });
    const m = /(\d+)\.\d+\.\d+/.exec(String(res.stdout ?? ""));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenCode's inline config with graph-manager's MCP server. OpenCode 2 keeps the servers under `mcp.servers` and
 * ignores an OpenCode 1 entry directly under `mcp`, and OpenCode 1 rejects `mcp.servers`, so the shape follows the
 * installed major version (1 when it is unknown).
 */
export function opencodeConfig(command: string, major: number | undefined): Record<string, unknown> {
  const $schema = "https://opencode.ai/config.json";
  if (major !== undefined && major >= 2) return { $schema, mcp: { servers: { [MCP_NAME]: { type: "local", command: [command], disabled: false } } } };
  return { $schema, mcp: { [MCP_NAME]: { type: "local", command: [command], enabled: true } } };
}

/**
 * OpenCode's command line. OpenCode 2 is a client of a background service shared by every terminal, and a service that
 * already runs was started without this terminal's `OPENCODE_CONFIG_CONTENT`, `GM_TERMINAL_ID` and token: it ignores
 * the injected config, so `/mcp` lists nothing. `--standalone` gives the terminal a private server with its own env.
 */
export function opencodeArgv(major: number | undefined): string[] {
  return major !== undefined && major >= 2 ? ["opencode", "--standalone"] : ["opencode"];
}

export const AGENTS: AgentAdapter[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    connect: "inject",
    launch: ({ dataDir }) => ({ argv: ["claude", "--mcp-config", claudeMcpConfigPath(dataDir), "--allowedTools", `mcp__${MCP_NAME}`] }),
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    connect: "inject",
    launch: ({ platform }) => ({ argv: ["codex", "-c", `mcp_servers.${MCP_NAME}.command="${mcpCommand(platform)}"`] }),
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    connect: "inject",
    launch: ({ platform, major = cliMajor("opencode") }) => ({
      argv: opencodeArgv(major),
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(mcpCommand(platform), major)) },
    }),
  },
  {
    id: "qwen",
    label: "Qwen Code",
    binary: "qwen",
    connect: "project-config",
    launch: () => ({ argv: ["qwen"] }),
    projectConfig: {
      file: ".qwen/settings.json",
      apply: (json) => ({ ...json, mcpServers: { ...(isObject(json.mcpServers) ? json.mcpServers : {}), [MCP_NAME]: { ...QWEN_ENTRY } } }),
      matches: (json) => isObject(json.mcpServers) && isDeepStrictEqual(json.mcpServers[MCP_NAME], QWEN_ENTRY),
    },
  },
];

export function getAgent(id: string): AgentAdapter | undefined {
  return AGENTS.find((a) => a.id === id);
}

const BARE = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** argv as one command line for the terminal's shell. */
export function commandLine(argv: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // PowerShell: single quotes, ' doubled; a quoted command needs the call operator.
    const tokens = argv.map((t) => (BARE.test(t) ? t : `'${t.replace(/'/g, "''")}'`));
    return tokens.length > 0 && tokens[0] !== argv[0] ? `& ${tokens.join(" ")}` : tokens.join(" ");
  }
  return argv.map((t) => (BARE.test(t) ? t : `'${t.replace(/'/g, "'\\''")}'`)).join(" ");
}

/**
 * Where `bin` resolves on the PATH, or undefined. Done in-process rather than with `which`, which Windows lacks.
 * On Windows it resolves the way the spawn does (cross-spawn, inside execa): a name without a PATHEXT extension gets
 * each PATHEXT extension in turn and is never taken bare. npm installs a CLI there as an extensionless `sh` shim next
 * to `claude.cmd`; Windows cannot run the bare one, so finding it would pass the check for a CLI that the shell then
 * resolves differently, or not at all. A name that already ends in a PATHEXT extension is taken as is.
 * (A copy of graph-execution's `findOnPath` in src/providers/index.ts.)
 */
export function findOnPath(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  stat: (file: string) => { isFile(): boolean; mode: number } = statSync,
): string | undefined {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  // Windows env names are case-insensitive, and `Path` is the usual spelling there.
  const get = (name: string): string | undefined =>
    win ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name];
  let exts = [""];
  if (win) {
    const pathExt = (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const own = p.extname(bin).toUpperCase();
    exts = own !== "" && pathExt.some((e) => e.toUpperCase() === own) ? [""] : pathExt;
  }
  for (const dir of (get("PATH") ?? "").split(p.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = p.resolve(cwd, dir, bin + ext);
      try {
        const st = stat(candidate);
        if (st.isFile() && (win || (st.mode & 0o111) !== 0)) return candidate;
      } catch {
        // Not there.
      }
    }
  }
  return undefined;
}

/** True when the agent's CLI is on the PATH; nothing is spawned. */
export function isInstalled(adapter: AgentAdapter, env: NodeJS.ProcessEnv = process.env): boolean {
  return findOnPath(adapter.binary, process.cwd(), env) !== undefined;
}

/** Writes `<dataDir>/agents/claude-mcp.json` (no secrets in it); returns its path. */
export function writeClaudeMcpConfig(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const file = claudeMcpConfigPath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const content = { mcpServers: { [MCP_NAME]: { type: "stdio", command: mcpCommand(platform), args: [] } } };
  writeFileSync(file, JSON.stringify(content, null, 2) + "\n", { mode: 0o644 });
  chmodSync(file, 0o644);
  return file;
}

/** Preparing an agent failed; `status` is the HTTP status to reply with. */
export class AgentPrepareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PrepareResult = { changed: false } | { changed: true; commit: string };

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await execa("git", args, { cwd, env: gitEnv(), reject: false, stdin: "ignore" });
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

/** The last few non-hint lines of git's output. */
function lastLines(text: string, n = 3): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("hint:"));
  return lines.slice(-n).join(" ") || "git commit failed";
}

const IN_PROGRESS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply"];

/**
 * For a `project-config` agent: adds graph-manager's MCP entry to the agent's project file in the workspace or project folder and
 * commits only that file. Does nothing when the entry is already there. Throws `AgentPrepareError` (409) when the
 * file is not valid JSON, has uncommitted changes, a merge/rebase/cherry-pick is in progress, HEAD is detached, or
 * the commit fails (the file is then restored).
 */
export async function prepareProjectConfig(adapter: AgentAdapter, target: { path: string }): Promise<PrepareResult> {
  const pc = adapter.projectConfig;
  if (!pc) return { changed: false };
  const file = path.join(target.path, ...pc.file.split("/"));
  let previous: string | undefined;
  try {
    previous = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let json: Record<string, unknown> = {};
  if (previous !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) throw new AgentPrepareError(409, `${pc.file} is not valid JSON`);
    json = parsed;
  }
  if (pc.matches(json)) return { changed: false };

  const refuse = (reason: string) => new AgentPrepareError(409, `cannot commit ${pc.file}: ${reason}`);
  const status = await git(target.path, ["status", "--porcelain", "--", pc.file]);
  if (!status.ok) throw refuse(lastLines(status.stderr));
  if (status.stdout !== "") throw refuse("it has uncommitted changes");
  for (const name of IN_PROGRESS) {
    const res = await git(target.path, ["rev-parse", "--git-path", name]);
    if (res.ok && res.stdout !== "" && existsSync(path.resolve(target.path, res.stdout))) throw refuse("a merge, rebase or cherry-pick is in progress");
  }
  if (!(await git(target.path, ["symbolic-ref", "-q", "HEAD"])).ok) throw refuse("HEAD is detached");

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(pc.apply(json), null, 2) + "\n");
  const add = await git(target.path, ["add", "--", pc.file]);
  const commit = add.ok ? await git(target.path, ["commit", "-q", "-m", `chore: connect graph-manager tools for ${adapter.label}`, "--", pc.file]) : add;
  if (!commit.ok) {
    if (previous === undefined) await rm(file, { force: true });
    else await writeFile(file, previous);
    await git(target.path, ["reset", "-q", "--", pc.file]);
    throw refuse(lastLines(commit.stderr || commit.stdout));
  }
  const head = await git(target.path, ["rev-parse", "HEAD"]);
  return { changed: true, commit: head.stdout };
}
