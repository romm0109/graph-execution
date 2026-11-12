// Temporary diagnostic: which OPENCODE_CONFIG_CONTENT makes a real OpenCode connect graph-manager's MCP server.
import { spawn, spawnSync } from "node:child_process";
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
run("serve help", ["serve", "--help"]);
const fwd = (d) => d.split(path.sep).join("/");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const newProj = () => {
  const d = mkdtempSync(path.join(tmp, "proj-"));
  spawnSync("git", ["init", "-q"], { cwd: d });
  return d;
};
// Asks up to 8 times, 1.5 s apart, until graph-manager is listed; prints every answer.
function poll(label, args, opts) {
  for (let i = 0; i < 8; i++) {
    const { out } = run(`${label} [try ${i + 1}]`, args, opts);
    if (/graph-manager|probe/.test(out)) return console.log(`RESULT ${label}: LISTED -> ${out.trim()}`);
    sleep(1500);
  }
  console.log(`RESULT ${label}: NOT LISTED after 8 tries`);
}
const locArgs = (dir, extra = []) => ["api", ...extra, "GET", `/api/mcp?location[directory]=${fwd(dir)}`];

// 1. Background service started by this call, with the inline config, asked for the project's location.
run("service stop", ["service", "stop"]);
let dir = newProj();
poll("FRESH service + inline, project location", locArgs(dir), { content: node, dir });
poll("same service, default location", ["api", "mcp.list"], { content: node, dir });
// 2. A second project on the same (now running) service, with the inline config.
dir = newProj();
poll("RUNNING service + inline, another project", locArgs(dir), { content: node, dir });
run("service stop", ["service", "stop"]);

// 3. Service started without the config; then a client with the inline config.
dir = newProj();
run("start service without config", ["api", "mcp.list"], { dir });
poll("STALE service + inline, project location", locArgs(dir), { content: node, dir });
run("reload with inline", ["reload"], { content: node, dir });
poll("STALE service + inline after reload", locArgs(dir), { content: node, dir });

// 4. A private server with the inline config, while that stale service still runs (what --standalone gives the TUI).
dir = newProj();
const port = 45990;
const serve = spawn(`opencode serve --hostname 127.0.0.1 --port ${port}`, { cwd: dir, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...baseEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(node) } });
let serveOut = "";
serve.stdout.on("data", (d) => (serveOut += d));
serve.stderr.on("data", (d) => (serveOut += d));
sleep(6000);
poll("PRIVATE server (serve) + inline, project location", locArgs(dir, ["--server", `http://127.0.0.1:${port}`]), { dir });
poll("PRIVATE server (serve) + inline, default location", ["api", "--server", `http://127.0.0.1:${port}`, "mcp.list"], { dir });
if (win) spawnSync("taskkill", ["/T", "/F", "/PID", String(serve.pid)]);
else serve.kill("SIGKILL");
// 5. --standalone itself: one call cannot wait for the connection, so this only shows whether the server is listed at all.
poll("api --standalone + inline, project location", locArgs(dir, ["--standalone"]), { content: node, dir });
run("service stop", ["service", "stop"]);

// 6. A project opencode.json, on a fresh service.
dir = newProj();
run("mcp add", ["mcp", "add", "probe", "--", process.execPath, mcpJs], { dir });
poll("FRESH service + project file, project location", locArgs(dir), { dir });
run("service stop", ["service", "stop"]);
process.exit(0);
