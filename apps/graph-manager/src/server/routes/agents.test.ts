import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";

// `--version` prints $FAKE_VERSION and records nothing: graph-manager asks OpenCode's version before it opens the terminal.
const FAKE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "$FAKE_VERSION"; exit 0; fi
{ printf '%s\\n' "$0" "$@"; printf 'OPENCODE_CONFIG_CONTENT=%s\\n' "$OPENCODE_CONFIG_CONTENT"; printf 'GM_TERMINAL_ID=%s\\n' "$GM_TERMINAL_ID"; } > "$FAKE_OUT/$(basename "$0").txt"
`;
const WS_ID = "github~octo~hello";

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let config: Config;
let cookie: string;
let fakebin: string;
let outDir: string;
let wsDir: string;

const git = async (...args: string[]) => String((await execa("git", args, { cwd: wsDir })).stdout).trim();

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  config = testConfig(t.dir);
  fakebin = path.join(t.dir, "fakebin");
  outDir = path.join(t.dir, "out");
  await mkdir(fakebin, { recursive: true });
  await mkdir(outDir, { recursive: true });
  for (const name of ["claude", "codex", "opencode", "qwen"]) await writeFile(path.join(fakebin, name), FAKE, { mode: 0o755 });
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@example.com");
  await writeFile(path.join(wsDir, "README.md"), "hi\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  // Before buildApp: the TerminalManager copies the env in its constructor.
  vi.stubEnv("PATH", `${fakebin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_OUT", outDir);
  app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false });
  cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "pw" } }));
});

afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  await cleanup();
});

const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload });
const listTerminals = async () => (await app.inject({ method: "GET", url: "/api/terminals", headers: { cookie } })).json().terminals as { id: string; status: string }[];

async function output(name: string): Promise<string[]> {
  const file = path.join(outDir, `${name}.txt`);
  for (let i = 0; i < 250; i++) {
    try {
      const text = await readFile(file, "utf8");
      if (text.includes("GM_TERMINAL_ID=")) return text.split("\n");
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${name} did not run`);
}

describe.skipIf(process.platform === "win32")("agent terminals", () => {
  it("lists the agents and whether each is installed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agents: [
        { id: "claude", label: "Claude Code", binary: "claude", installed: true, connect: "inject" },
        { id: "codex", label: "Codex", binary: "codex", installed: true, connect: "inject" },
        { id: "opencode", label: "OpenCode", binary: "opencode", installed: true, connect: "inject" },
        { id: "qwen", label: "Qwen Code", binary: "qwen", installed: true, connect: "project-config" },
      ],
    });
    await rm(path.join(fakebin, "qwen"));
    const after = (await app.inject({ method: "GET", url: "/api/agents", headers: { cookie } })).json();
    expect(after.agents.find((a: { id: string }) => a.id === "qwen").installed).toBe(false);
    const create = await post({ agent: "qwen", workspaceId: WS_ID });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toEqual({ error: "qwen is not installed" });
    expect(await listTerminals()).toHaveLength(0);
  });

  it("opens Claude Code with graph-manager's MCP config; the shell stays after it exits", async () => {
    const res = await post({ workspaceId: WS_ID, agent: "claude" });
    expect(res.statusCode).toBe(201);
    const info = res.json();
    expect(info.agent).toBe("claude");
    expect(info.title).toBe("Claude Code · hello");
    expect(info.connected).toBeUndefined();
    const lines = await output("claude");
    const mcpConfig = path.join(config.dataDir, "agents", "claude-mcp.json");
    expect(lines).toEqual(expect.arrayContaining(["--mcp-config", mcpConfig, "--allowedTools", "mcp__graph-manager", `GM_TERMINAL_ID=${info.id}`]));
    expect(JSON.parse(await readFile(mcpConfig, "utf8")).mcpServers["graph-manager"].command).toBe("graph-manager-mcp");
    await new Promise((r) => setTimeout(r, 200));
    const t = (await listTerminals()).find((x) => x.id === info.id);
    expect(t?.status).not.toBe("exited");
  });

  it("opens Codex with the MCP server flag", async () => {
    const res = await post({ workspaceId: WS_ID, agent: "codex", title: "mine" });
    expect(res.statusCode).toBe(201);
    expect(res.json().title).toBe("mine");
    const lines = await output("codex");
    expect(lines).toEqual(expect.arrayContaining(["-c", 'mcp_servers.graph-manager.command="graph-manager-mcp"']));
  });

  it("opens OpenCode with OPENCODE_CONFIG_CONTENT", async () => {
    const res = await post({ agent: "opencode" });
    expect(res.statusCode).toBe(201);
    expect(res.json().title).toBe("OpenCode");
    const line = (await output("opencode")).find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="))!;
    const json = JSON.parse(line.slice("OPENCODE_CONFIG_CONTENT=".length));
    expect(json.mcp["graph-manager"].command).toEqual(["graph-manager-mcp"]);
  });

  it("gives OpenCode 2 the server under mcp.servers", async () => {
    vi.stubEnv("FAKE_VERSION", "2.2.7");
    const res = await post({ agent: "opencode" });
    expect(res.statusCode).toBe(201);
    const line = (await output("opencode")).find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="))!;
    const json = JSON.parse(line.slice("OPENCODE_CONFIG_CONTENT=".length));
    expect(json.mcp).toEqual({ servers: { "graph-manager": { type: "local", command: ["graph-manager-mcp"], disabled: false } } });
  });

  it("connects Qwen Code by committing .qwen/settings.json once", async () => {
    const res = await post({ workspaceId: WS_ID, agent: "qwen" });
    expect(res.statusCode).toBe(201);
    const head = await git("rev-parse", "HEAD");
    expect(res.json().connected).toEqual({ changed: true, commit: head });
    expect(await git("log", "-1", "--format=%s")).toBe("chore: connect graph-manager tools for Qwen Code");
    await output("qwen");

    const again = await post({ workspaceId: WS_ID, agent: "qwen" });
    expect(again.statusCode).toBe(201);
    expect(again.json().connected).toEqual({ changed: false });
    expect(await git("rev-parse", "HEAD")).toBe(head);

    await writeFile(path.join(wsDir, ".qwen", "settings.json"), '{"theme":"y"}\n');
    const before = (await listTerminals()).length;
    const dirty = await post({ workspaceId: WS_ID, agent: "qwen" });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toEqual({ error: "cannot commit .qwen/settings.json: it has uncommitted changes" });
    expect(await listTerminals()).toHaveLength(before);

    const root = await post({ agent: "qwen" });
    expect(root.statusCode).toBe(400);
    expect(root.json()).toEqual({ error: "Qwen Code needs a workspace" });
  });

  it("rejects an unknown agent", async () => {
    const res = await post({ agent: "vim" });
    expect(res.statusCode).toBe(400);
    expect(await listTerminals()).toHaveLength(0);
  });
});
