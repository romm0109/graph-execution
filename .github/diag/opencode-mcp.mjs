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
  const res = spawnSync("opencode", args.map((a) => (/[^A-Za-z0-9_.:\/\\=-]/.test(a) ? `"${a}"` : a)), { cwd, env, shell: true, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  console.log(`exit=${res.status} signal=${res.signal ?? ""} error=${res.error?.message ?? ""}`);
  console.log(`--- stdout\n${String(res.stdout).slice(0, 2500)}\n--- stderr\n${String(res.stderr).slice(0, 3000)}`);
  return { out: String(res.stdout), cwd };
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
run("version", ["--version"]);
const fwd = (d) => d.split(path.sep).join("/");
// Every way of asking the server which MCP servers it has, from directory `dir`.
function ask(label, opts) {
  const dir = opts.dir ?? mkdtempSync(path.join(tmp, "proj-"));
  if (!opts.dir) spawnSync("git", ["init", "-q"], { cwd: dir });
  const o = { ...opts, dir };
  const extra = opts.standalone ? ["--standalone"] : [];
  run(`${label}: GET /api/mcp`, ["api", ...extra, "GET", "/api/mcp"], o);
  run(`${label}: GET /api/mcp?location[directory]`, ["api", ...extra, "GET", `/api/mcp?location[directory]=${fwd(dir)}`], o);
  run(`${label}: mcp.list`, ["api", ...extra, "mcp.list"], o);
  run(`${label}: mcp.list --param directory`, ["api", ...extra, "--param", `directory=${fwd(dir)}`, "mcp.list"], o);
  run(`${label}: location.get`, ["api", ...extra, "location.get"], o);
}
run("service stop", ["service", "stop"]);
ask("FRESH service, inline node+mcp.js", { content: node });
run("service stop", ["service", "stop"]);
ask("FRESH service, inline shim name", { content: v2([shim], { disabled: false }) });
run("service stop", ["service", "stop"]);
ask("service started WITHOUT config", {});
ask("STALE service, inline node+mcp.js", { content: node });
ask("STANDALONE, inline node+mcp.js (service still running)", { content: node, standalone: true });
ask("STANDALONE, inline shim name", { content: v2([shim], { disabled: false }), standalone: true });
run("service stop", ["service", "stop"]);
const proj = mkdtempSync(path.join(tmp, "add-"));
spawnSync("git", ["init", "-q"], { cwd: proj });
run("mcp add", ["mcp", "add", "probe", "--", process.execPath, mcpJs], { dir: proj });
ask("project file from mcp add", { dir: proj });
run("service stop", ["service", "stop"]);
