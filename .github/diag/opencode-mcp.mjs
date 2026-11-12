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

function run(title, args, { content, file, cli, dir } = {}) {
  const cwd = dir ?? mkdtempSync(path.join(tmp, "proj-"));
  if (!dir) spawnSync("git", ["init", "-q"], { cwd });
  const env = { ...baseEnv };
  if (content) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
  if (cli) env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify(cli);
  if (file) writeFileSync(path.join(cwd, "opencode.json"), JSON.stringify(file, null, 2));
  console.log(`\n===== ${title}: opencode ${args.join(" ")}`);
  if (content) console.log(`OPENCODE_CONFIG_CONTENT=${env.OPENCODE_CONFIG_CONTENT}`);
  if (file) console.log(`opencode.json=${JSON.stringify(file)}`);
  const res = spawnSync("opencode", args, { cwd, env, shell: true, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  console.log(`exit=${res.status} signal=${res.signal ?? ""} error=${res.error?.message ?? ""}`);
  console.log(`--- stdout\n${String(res.stdout).slice(0, 6000)}\n--- stderr\n${String(res.stderr).slice(0, 3000)}`);
  return String(res.stdout);
}

const node = v2([process.execPath, mcpJs], { disabled: false });
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
function dump(label, dir, depth = 0) {
  if (!existsSync(dir)) return console.log(`[${label}] ${dir}: missing`);
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) { if (depth < 2) dump(label, f, depth + 1); continue; }
    const size = statSync(f).size;
    console.log(`[${label}] ${f} (${size} bytes)${size < 3000 && /\.(jsonc?|toml)$/.test(name) ? `\n${readFileSync(f, "utf8")}` : ""}`);
  }
}
const home = os.homedir();
run("version", ["--version"]);
run("mcp list help", ["mcp", "list", "--help"]);
run("mcp add help", ["mcp", "add", "--help"]);
run("debug paths", ["debug", "paths"]);
run("service get", ["service", "get"]);

// What does OpenCode itself write for a local MCP server, and does `mcp list` then show it?
const proj = mkdtempSync(path.join(tmp, "add-"));
spawnSync("git", ["init", "-q"], { cwd: proj });
run("mcp add (guess 1)", ["mcp", "add", "probe", "--", process.execPath, mcpJs], { dir: proj });
run("mcp add (guess 2)", ["mcp", "add", "probe2", process.execPath, mcpJs], { dir: proj });
dump("project after add", proj);
dump("global config", path.join(home, ".config", "opencode"));
run("mcp list after add", ["mcp", "list"], { dir: proj });
run("debug config after add", ["debug", "config"], { dir: proj });

// The server's API: which operations mention mcp, and what they answer with the inline config.
run("service stop", ["service", "stop"]);
for (const p of ["/doc", "/openapi.json", "/v2/doc", "/v2/openapi.json"]) {
  const out = run(`api GET ${p} (inline v2)`, ["api", "GET", p], { content: node });
  const hits = [...new Set(out.match(/"[^"]*mcp[^"]*"/gi) ?? [])].slice(0, 80);
  console.log(`mcp mentions in ${p}: ${hits.join(" ")}`);
}
for (const p of ["/mcp", "/v2/mcp", "/config", "/v2/config"]) run(`api GET ${p} (inline v2, same service)`, ["api", "GET", p], { content: node });
run("service stop", ["service", "stop"]);
for (const p of ["/mcp", "/v2/mcp"]) run(`api GET ${p} --standalone (inline v2)`, ["api", "--standalone", "GET", p], { content: node });
run("service stop", ["service", "stop"]);
