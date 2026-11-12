/**
 * The provider catalog: one table describing every agent CLI graph-execution and graph-manager know about.
 *
 * Adding an agent starts here: add an entry (with `engine: false`), then write the engine adapter in
 * `providers/<id>.ts`, wire it into `getProvider` in `providers/index.ts` and flip `engine` to `true`. The CLI's
 * `--provider` list, the reviewer providers, graph-manager's sandbox login files and env allowlist, the sandbox CLI
 * image and the terminal env scrubbing all derive from this table.
 *
 * Kept free of `node:` imports so any bundle can read it.
 */

/** How the CLI gets graph-execution's MCP server. */
export type McpMode = "inject" | "project-config" | "user-config" | "extension";

export interface ProviderInfo {
  id: string;
  label: string;
  bin: string;
  npmPackage: string;
  /** True when the engine has an adapter (`--provider <id>` works). */
  engine: boolean;
  /** Relative to HOME; a trailing "/" is a folder. */
  loginFiles: readonly string[];
  /** Env keys that log the CLI in without files. */
  loginEnv: readonly string[];
  /** Env vars a running session of this CLI sets; stripped from graph-manager terminals. */
  sessionEnv: RegExp;
  /** User-level skill folders, relative to HOME. */
  userSkillDirs: readonly string[];
  /** Project-level skill folder, relative to the repo root. */
  projectSkillDir: string;
  mcp: McpMode;
}

const PI_LOGIN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

export const PROVIDER_CATALOG: readonly ProviderInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    engine: true,
    loginFiles: [".claude/.credentials.json", ".claude.json"],
    loginEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    sessionEnv: /^(CLAUDECODE$|CLAUDE_|CCR_)/,
    userSkillDirs: [".claude/skills"],
    projectSkillDir: ".claude/skills",
    mcp: "inject",
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    npmPackage: "@openai/codex",
    engine: true,
    loginFiles: [".codex/auth.json", ".codex/config.toml"],
    loginEnv: ["OPENAI_API_KEY"],
    sessionEnv: /^(CODEX_SANDBOX|CODEX_THREAD_ID$)/,
    userSkillDirs: [".agents/skills", ".codex/skills"],
    projectSkillDir: ".agents/skills",
    mcp: "inject",
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    npmPackage: "@opencode/cli",
    engine: true,
    loginFiles: [".local/share/opencode/auth.json", ".config/opencode/"],
    loginEnv: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    sessionEnv: /^(OPENCODE$|OPENCODE_SERVER)/,
    userSkillDirs: [".agents/skills", ".config/opencode/skills"],
    projectSkillDir: ".opencode/skills",
    mcp: "inject",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bin: "qwen",
    npmPackage: "@qwen-code/qwen-code",
    engine: true,
    loginFiles: [".qwen/oauth_creds.json", ".qwen/settings.json"],
    loginEnv: ["OPENAI_API_KEY"],
    sessionEnv: /^QWEN_CODE$/,
    userSkillDirs: [".qwen/skills"],
    projectSkillDir: ".qwen/skills",
    mcp: "project-config",
  },
  {
    id: "pi",
    label: "pi",
    bin: "pi",
    npmPackage: "@mariozechner/pi-coding-agent",
    engine: true,
    loginFiles: [".pi/agent/auth.json", ".pi/agent/models.json", ".pi/agent/settings.json"],
    loginEnv: PI_LOGIN_ENV,
    sessionEnv: /^PI_CODING_AGENT$/,
    userSkillDirs: [".pi/agent/skills", ".agents/skills"],
    projectSkillDir: ".pi/skills",
    mcp: "extension",
  },
  {
    id: "omp",
    label: "oh-my-pi",
    bin: "omp",
    npmPackage: "@oh-my-pi/pi-coding-agent",
    engine: true,
    loginFiles: [".omp/agent/agent.db", ".omp/agent/config.yml", ".omp/agent/models.yml"],
    loginEnv: [...PI_LOGIN_ENV, "COPILOT_GITHUB_TOKEN"],
    sessionEnv: /^(OMPCODE|AGENT|PI_SESSION_ID|PI_SESSION_FILE|PI_TOOL_CALL_ID)$/,
    userSkillDirs: [".omp/agent/skills", ".agents/skills"],
    projectSkillDir: ".omp/skills",
    mcp: "user-config",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    bin: "copilot",
    npmPackage: "@github/copilot",
    engine: true,
    loginFiles: [".copilot/config.json", ".copilot/settings.json"],
    loginEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    sessionEnv: /^COPILOT_(CLI|AGENT_SESSION_ID|LOADER_PID|CLI_PATH|CLI_BINARY_VERSION|CLI_RESOLVED_DIST_DIR)$/,
    userSkillDirs: [".copilot/skills", ".agents/skills"],
    projectSkillDir: ".github/skills",
    mcp: "inject",
  },
];

/** Every catalog id, in catalog order. */
export const PROVIDER_IDS: readonly string[] = PROVIDER_CATALOG.map((p) => p.id);

/** Ids the engine has an adapter for (`--provider <id>` works), in catalog order. */
export const ENGINE_PROVIDER_IDS: readonly string[] = PROVIDER_CATALOG.filter((p) => p.engine).map((p) => p.id);

/** The catalog entry for `id`, or undefined. */
export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/** npm packages installed into graph-manager's sandbox CLI image: every CLI, then Bun (omp runs on it). */
export const SANDBOX_CLI_PACKAGES: readonly string[] = [...PROVIDER_CATALOG.map((p) => p.npmPackage), "bun"];

/** The deduplicated union of every entry's `loginEnv`, in first-seen order. */
export function loginEnvKeys(): string[] {
  return [...new Set(PROVIDER_CATALOG.flatMap((p) => p.loginEnv))];
}
