// Temporary diagnostic: which OPENCODE_CONFIG_CONTENT makes a real OpenCode connect graph-manager's MCP server.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const win = process.platform === "win32";
const mcpJs = path.resolve("apps/graph-manager/dist/server/mcp.js");
const tmp = mkdtempSync(path.join(os.tmpdir(), "oc-diag-"));
const bin = path.join(tmp, "bin");
mkdirSync(bin);
if (win) writeFileSync(path.join(bin, "graph-manager-mcp.cmd"), `@echo off\r\nnode "${mcpJs}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
else {
  writeFileSync(path.join(bin, "graph-manager-mcp"), `#!/bin/sh\nexec node ${JSON.stringify(mcpJs)} "$@"\n`);
  chmodSync(path.join(bin, "graph-manager-mcp"), 0o755);
}
const shim = win ? "graph-manager-mcp.cmd" : "graph-manager-mcp";
const $schema = "https://opencode.ai/config.json";
const v2 = (command, extra = {}) => ({ $schema, mcp: { servers: { "graph-manager": { type: "local", command, ...extra } } } });
const v1 = (command) => ({ $schema, mcp: { "graph-manager": { type: "local", command, enabled: true } } });

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const baseEnv = { ...process.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}`, GM_TERMINAL_ID: "t1", GM_INTERNAL_URL: "http://127.0.0.1:9", GM_INTERNAL_TOKEN: "x" };

function run(title, args, { content, file, cli } = {}) {
  const cwd = mkdtempSync(path.join(tmp, "proj-"));
  spawnSync("git", ["init", "-q"], { cwd });
  const env = { ...baseEnv };
  if (content) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
  if (cli) env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify(cli);
  if (file) writeFileSync(path.join(cwd, "opencode.json"), JSON.stringify(file, null, 2));
  console.log(`\n===== ${title}: opencode ${args.join(" ")}`);
  if (content) console.log(`OPENCODE_CONFIG_CONTENT=${env.OPENCODE_CONFIG_CONTENT}`);
  if (file) console.log(`opencode.json=${JSON.stringify(file)}`);
  const res = spawnSync("opencode", args, { cwd, env, shell: true, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  console.log(`exit=${res.status} signal=${res.signal ?? ""} error=${res.error?.message ?? ""}`);
  console.log(`--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`);
}

run("version", ["--version"]);
run("help", ["--help"]);
run("mcp help", ["mcp", "--help"]);
run("baseline, no config", ["mcp", "list"]);
run("inline v2, shim name", ["mcp", "list"], { content: v2([shim]) });
run("inline v2, shim name + disabled:false", ["mcp", "list"], { content: v2([shim], { disabled: false }) });
run("inline v2, node + mcp.js", ["mcp", "list"], { content: v2([process.execPath, mcpJs], { disabled: false }) });
run("inline v2, bare 'node' + mcp.js", ["mcp", "list"], { content: v2(["node", mcpJs]) });
if (win) run("inline v2, cmd /c shim", ["mcp", "list"], { content: v2(["cmd.exe", "/d", "/s", "/c", "graph-manager-mcp.cmd"]) });
run("inline v1 shape", ["mcp", "list"], { content: v1([shim]) });
run("project file v2, node + mcp.js", ["mcp", "list"], { file: v2([process.execPath, mcpJs]) });
run("project file v2, shim name", ["mcp", "list"], { file: v2([shim]) });
run("debug config, inline v2", ["debug", "config"], { content: v2([process.execPath, mcpJs]) });
