// End-to-end check of the OpenCode button with a real OpenCode: `node apps/graph-manager/scripts/agents-e2e.mjs`
// after `npm run build`, with `opencode` on the PATH. CI: .github/workflows/agents-e2e.yml.
//
// It starts graph-manager from dist, makes sure OpenCode's background service already runs (started without
// graph-manager's config: the case that showed an empty /mcp), opens an OpenCode terminal the way the button does,
// and passes when the `graph-manager-mcp` process that OpenCode starts asks this graph-manager for its tools.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import WebSocket from "ws";

const WAIT_MS = 120_000;

// The check runs in a child process and this parent ends it once it has printed its verdict: a Windows pseudo-terminal
// keeps its process alive after the terminal is killed, which would hang the CI job after a PASS.
if (!process.env.GM_AGENTS_E2E_CHILD) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GM_AGENTS_E2E_CHILD: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  let verdict;
  const finish = (code) => {
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
    process.exit(code);
  };
  const giveUp = setTimeout(() => {
    console.error("FAIL: no verdict within 5 minutes");
    finish(1);
  }, 300_000);
  child.stdout.on("data", (d) => {
    process.stdout.write(d);
    out += d;
    if (verdict !== undefined) return;
    if (/^PASS:/m.test(out)) verdict = 0;
    else if (/^FAIL:/m.test(out)) verdict = 1;
    // A moment for the child's last lines and its own cleanup.
    if (verdict !== undefined) setTimeout(() => finish(verdict), 20_000);
  });
  child.on("exit", (code) => {
    clearTimeout(giveUp);
    finish(verdict ?? code ?? 1);
  });
  await new Promise(() => undefined);
}
const { buildApp } = await import(new URL("../dist/server/app.js", import.meta.url).href);

function opencode(args, cwd) {
  const res = spawnSync("opencode", args, { cwd, shell: true, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  console.log(`$ opencode ${args.join(" ")}\n${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd());
  return res;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "gm-agents-e2e-"));
const workspacesDir = path.join(tmp, "ws");
mkdirSync(workspacesDir, { recursive: true });
const config = {
  password: "pw",
  port: 0,
  host: "127.0.0.1",
  dataDir: path.join(tmp, "data"),
  workspacesDir,
  githubApiUrl: "https://api.github.com",
  graphExecutionBin: "graph-execution",
};

const version = opencode(["--version"], tmp);
if (version.status !== 0) {
  console.log("FAIL: opencode is not on the PATH");
  process.exit(1);
}
const major = Number(/(\d+)\.\d+\.\d+/.exec(version.stdout ?? "")?.[1]);
if (major >= 2) {
  // A background service that was started without graph-manager's config, as on a machine where OpenCode is in use.
  opencode(["service", "stop"], tmp);
  opencode(["api", "mcp.list"], tmp);
  opencode(["service", "status"], tmp);
}

console.log("starting graph-manager");
const app = await buildApp(config, { viewCache: false, webDir: path.join(tmp, "no-web") });
let toolRequests = 0;
app.addHook("onResponse", async (req, reply) => {
  if (req.url.startsWith("/api/internal/tools") && reply.statusCode === 200) toolRequests++;
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;

let screen = "";
let ok = false;
try {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "pw" } });
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  const created = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { agent: "opencode", cols: 120, rows: 40 } });
  if (created.statusCode !== 201) throw new Error(`POST /api/terminals answered ${created.statusCode}: ${created.body}`);
  const { id } = created.json();
  console.log(`opened OpenCode terminal ${id}; waiting for graph-manager-mcp`);
  // The terminal's output, to show on a failure.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers: { cookie } });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "replay" || msg.type === "data") screen += msg.data;
  });
  ws.on("error", () => undefined);
  const deadline = Date.now() + WAIT_MS;
  while (toolRequests === 0 && Date.now() < deadline) await sleep(500);
  ok = toolRequests > 0;
  ws.terminate();
} catch (err) {
  console.error(err);
}
if (major >= 2) opencode(["service", "stop"], tmp);
if (ok) {
  console.log(`PASS: OpenCode ${version.stdout.trim()} started graph-manager-mcp, which asked graph-manager for its tools (${toolRequests} request(s)).`);
} else {
  // eslint-disable-next-line no-control-regex
  const text = screen.replace(/\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, " ").replace(/\s{2,}/g, "\n");
  console.log(`FAIL: no request reached /api/internal/tools within ${WAIT_MS / 1000} s. The terminal showed:\n${text.slice(-3000)}`);
}

// The verdict is printed; cleaning up must not hang the job (closing a Windows pseudo-terminal can take long).
console.log("closing graph-manager");
await Promise.race([app.close().catch(() => undefined), sleep(10_000)]);
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // Windows may still hold the folder; the runner's temp dir is thrown away.
}
process.exit(ok ? 0 : 1);
