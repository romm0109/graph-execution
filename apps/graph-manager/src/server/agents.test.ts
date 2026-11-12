import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS, AgentPrepareError, commandLine, getAgent, isInstalled, mcpArgv, mcpCommand, mcpJsPath, prepareProjectConfig, writeClaudeMcpConfig, type AgentAdapter } from "./agents.js";
import { tempDir } from "./test-helpers.js";
import type { Workspace } from "./workspaces.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const agent = (id: string): AgentAdapter => getAgent(id)!;

describe("agent adapters", () => {
  it("lists the four agents", () => {
    expect(AGENTS.map((a) => [a.id, a.label, a.binary, a.connect])).toEqual([
      ["claude", "Claude Code", "claude", "inject"],
      ["codex", "Codex", "codex", "inject"],
      ["opencode", "OpenCode", "opencode", "inject"],
      ["qwen", "Qwen Code", "qwen", "project-config"],
    ]);
  });

  it("launches each agent with exactly the spec's flags and env", () => {
    const dataDir = path.join("/d", "data");
    expect(agent("claude").launch({ dataDir, platform: "linux" })).toEqual({
      argv: ["claude", "--mcp-config", path.join(dataDir, "agents", "claude-mcp.json"), "--allowedTools", "mcp__graph-manager"],
    });
    expect(agent("codex").launch({ dataDir, platform: "linux" })).toEqual({ argv: ["codex", "-c", 'mcp_servers.graph-manager.command="graph-manager-mcp"'] });
    const oc = agent("opencode").launch({ dataDir, platform: "linux", major: 1 });
    expect(oc.argv).toEqual(["opencode"]);
    expect(JSON.parse(oc.env!.OPENCODE_CONFIG_CONTENT!)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { "graph-manager": { type: "local", command: ["graph-manager-mcp"], enabled: true } },
    });
    // OpenCode 2 reads MCP servers from `mcp.servers` and ignores the OpenCode 1 entry.
    const oc2 = agent("opencode").launch({ dataDir, platform: "linux", major: 2 });
    expect(JSON.parse(oc2.env!.OPENCODE_CONFIG_CONTENT!)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: { "graph-manager": { type: "local", command: ["graph-manager-mcp"], disabled: false } } },
    });
    expect(agent("qwen").launch({ dataDir, platform: "linux" })).toEqual({ argv: ["qwen"] });
    expect(agent("qwen").projectConfig?.file).toBe(".qwen/settings.json");
  });

  it("writes Claude Code's MCP config", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const file = writeClaudeMcpConfig(t.dir, "linux");
    expect(file).toBe(path.join(t.dir, "agents", "claude-mcp.json"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      mcpServers: { "graph-manager": { type: "stdio", command: "graph-manager-mcp", args: [] } },
    });
  });

  it("names graph-manager-mcp.cmd on Windows, except in Qwen's committed entry", async () => {
    expect(mcpCommand("win32")).toBe("graph-manager-mcp.cmd");
    expect(mcpCommand("darwin")).toBe("graph-manager-mcp");
    const dataDir = path.join("/d", "data");
    expect(agent("claude").launch({ dataDir, platform: "win32" })).toEqual(agent("claude").launch({ dataDir, platform: "linux" }));
    expect(agent("codex").launch({ dataDir, platform: "win32" })).toEqual({
      argv: ["codex", "-c", 'mcp_servers.graph-manager.command="graph-manager-mcp.cmd"'],
    });
    // OpenCode gets node and mcp.js on Windows: it starts the command without a shell and cannot run a `.cmd` file.
    const win = { dataDir, platform: "win32" as const, node: "C:\\node\\node.exe", mcpJs: "C:\\gm\\server\\mcp.js" };
    const oc = agent("opencode").launch({ ...win, major: 1 });
    expect(JSON.parse(oc.env!.OPENCODE_CONFIG_CONTENT!).mcp["graph-manager"].command).toEqual(["C:\\node\\node.exe", "C:\\gm\\server\\mcp.js"]);
    const oc2 = agent("opencode").launch({ ...win, major: 2 });
    expect(JSON.parse(oc2.env!.OPENCODE_CONFIG_CONTENT!).mcp.servers["graph-manager"].command).toEqual(["C:\\node\\node.exe", "C:\\gm\\server\\mcp.js"]);
    expect(mcpArgv("win32")).toEqual([process.execPath, mcpJsPath()]);
    expect(mcpArgv("linux")).toEqual(["graph-manager-mcp"]);
    const t = await tempDir();
    cleanup = t.cleanup;
    expect(JSON.parse(await readFile(writeClaudeMcpConfig(t.dir, "win32"), "utf8"))).toEqual({
      mcpServers: { "graph-manager": { type: "stdio", command: "graph-manager-mcp.cmd", args: [] } },
    });
    expect(agent("qwen").launch({ dataDir, platform: "win32" })).toEqual({ argv: ["qwen"] });
    expect(agent("qwen").projectConfig!.apply({})).toEqual({
      mcpServers: { "graph-manager": { command: "graph-manager-mcp", trust: true } },
    });
  });
});

describe("commandLine", () => {
  it("quotes for POSIX shells", () => {
    expect(commandLine(["codex", "-c", 'mcp_servers.graph-manager.command="graph-manager-mcp"'], "linux")).toBe(
      `codex -c 'mcp_servers.graph-manager.command="graph-manager-mcp"'`,
    );
    expect(commandLine(["claude", "--mcp-config", "/a b/c.json", "--allowedTools", "mcp__graph-manager"], "darwin")).toBe(
      "claude --mcp-config '/a b/c.json' --allowedTools mcp__graph-manager",
    );
    expect(commandLine(["echo", "it's"], "linux")).toBe(`echo 'it'\\''s'`);
    expect(commandLine(["echo", ""], "linux")).toBe("echo ''");
  });

  it("quotes for PowerShell", () => {
    expect(commandLine(["codex", "-c", 'mcp_servers.graph-manager.command="graph-manager-mcp"'], "win32")).toBe(
      `codex -c 'mcp_servers.graph-manager.command="graph-manager-mcp"'`,
    );
    expect(commandLine(["echo", "it's"], "win32")).toBe(`echo 'it''s'`);
    expect(commandLine(["C:\\Program Files\\x.exe", "a"], "win32")).toBe(`& 'C:\\Program Files\\x.exe' a`);
  });
});

describe.skipIf(process.platform === "win32")("isInstalled", () => {
  it("finds an executable on PATH without spawning it", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(path.join(t.dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(t.dir, "qwen"), "not executable", { mode: 0o644 });
    expect(isInstalled(agent("codex"), { PATH: t.dir })).toBe(true);
    expect(isInstalled(agent("qwen"), { PATH: t.dir })).toBe(false);
    expect(isInstalled(agent("codex"), { PATH: "" })).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("prepareProjectConfig", () => {
  const qwen = () => agent("qwen");
  const FILE = ".qwen/settings.json";

  async function repo(): Promise<{ ws: Workspace; git: (...a: string[]) => Promise<string> }> {
    const t = await tempDir();
    cleanup = t.cleanup;
    const dir = path.join(t.dir, "github", "octo", "hello");
    await mkdir(dir, { recursive: true });
    const git = async (...args: string[]) => String((await execa("git", args, { cwd: dir })).stdout).trim();
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "t");
    await git("config", "user.email", "t@example.com");
    await writeFile(path.join(dir, "README.md"), "hi\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "init");
    return { ws: { id: "github~octo~hello", path: dir, rel: "github/octo/hello", forge: "github", fullPath: "octo/hello" }, git };
  }

  async function rejection(p: Promise<unknown>): Promise<AgentPrepareError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentPrepareError);
    return err as AgentPrepareError;
  }

  it("commits only the settings file, then does nothing the second time", async () => {
    const { ws, git } = await repo();
    await writeFile(path.join(ws.path, "README.md"), "changed\n");
    await writeFile(path.join(ws.path, "other.txt"), "x\n");
    await git("add", "other.txt");
    const res = await prepareProjectConfig(qwen(), ws);
    expect(res.changed).toBe(true);
    const head = await git("rev-parse", "HEAD");
    expect(res).toEqual({ changed: true, commit: head });
    expect(await git("show", "--name-only", "--format=%s", "HEAD")).toBe(`chore: connect graph-manager tools for Qwen Code\n\n${FILE}`);
    expect(JSON.parse(await readFile(path.join(ws.path, FILE), "utf8"))).toEqual({
      mcpServers: { "graph-manager": { command: "graph-manager-mcp", trust: true } },
    });
    const status = await git("status", "--porcelain");
    expect(status.split("\n")).toEqual(["M README.md", "A  other.txt"]);

    expect(await prepareProjectConfig(qwen(), ws)).toEqual({ changed: false });
    expect(await git("rev-parse", "HEAD")).toBe(head);
  });

  it("keeps other keys and other servers", async () => {
    const { ws, git } = await repo();
    await mkdir(path.join(ws.path, ".qwen"));
    await writeFile(path.join(ws.path, FILE), JSON.stringify({ theme: "x", mcpServers: { other: { command: "o" } } }));
    await git("add", ".");
    await git("commit", "-q", "-m", "settings");
    expect((await prepareProjectConfig(qwen(), ws)).changed).toBe(true);
    const text = await readFile(path.join(ws.path, FILE), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      theme: "x",
      mcpServers: { other: { command: "o" }, "graph-manager": { command: "graph-manager-mcp", trust: true } },
    });
  });

  it("refuses a file with uncommitted changes", async () => {
    const { ws, git } = await repo();
    await mkdir(path.join(ws.path, ".qwen"));
    await writeFile(path.join(ws.path, FILE), "{}\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "settings");
    await writeFile(path.join(ws.path, FILE), '{"theme":"y"}\n');
    const err = await rejection(prepareProjectConfig(qwen(), ws));
    expect(err.status).toBe(409);
    expect(err.message).toBe(`cannot commit ${FILE}: it has uncommitted changes`);
  });

  it("refuses a detached HEAD", async () => {
    const { ws, git } = await repo();
    await git("checkout", "-q", "--detach");
    const err = await rejection(prepareProjectConfig(qwen(), ws));
    expect(err.status).toBe(409);
    expect(err.message).toBe(`cannot commit ${FILE}: HEAD is detached`);
  });

  it("refuses while a merge is in progress", async () => {
    const { ws, git } = await repo();
    await writeFile(path.join(ws.path, ".git", "MERGE_HEAD"), (await git("rev-parse", "HEAD")) + "\n");
    const err = await rejection(prepareProjectConfig(qwen(), ws));
    expect(err.message).toBe(`cannot commit ${FILE}: a merge, rebase or cherry-pick is in progress`);
  });

  it("refuses invalid JSON", async () => {
    const { ws } = await repo();
    await mkdir(path.join(ws.path, ".qwen"));
    await writeFile(path.join(ws.path, FILE), "{nope");
    const err = await rejection(prepareProjectConfig(qwen(), ws));
    expect(err.status).toBe(409);
    expect(err.message).toBe(`${FILE} is not valid JSON`);
  });

  it("restores the file when the commit fails", async () => {
    const { ws, git } = await repo();
    await writeFile(path.join(ws.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'error: hook says no' >&2\nexit 1\n", { mode: 0o755 });
    const err = await rejection(prepareProjectConfig(qwen(), ws));
    expect(err.status).toBe(409);
    expect(err.message).toContain(`cannot commit ${FILE}: `);
    expect(err.message).toContain("hook says no");
    expect(await git("status", "--porcelain")).toBe("");
  });
});
