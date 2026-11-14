// Smoke test of the packaged desktop app (run `npm run dist -w graph-manager-desktop` first). Starts the app in smoke
// mode with a temp user-data dir and checks: the bundled server answers, the session cookie works, a terminal echoes
// through its WebSocket (node-pty loads inside Electron), a `--provider fake` run started from the API finishes (the
// handed-off run process starts under the Electron binary), and quitting stops the server. Plain Node, cross-platform.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.join(desktopDir, "release");
const WebSocket = createRequire(import.meta.url)("ws");

const START_TIMEOUT_MS = 90_000;
const ECHO_TIMEOUT_MS = 20_000;
const QUIT_TIMEOUT_MS = 15_000;
const MARKER = "gm-smoke-ok";
const RUN_TIMEOUT_MS = 180_000;
const RUN_DONE = new Set(["applied", "done"]);
const RUN_FAILED = new Set(["failed", "aborted"]);

function binaryPath() {
  if (process.platform === "darwin") {
    const sub = process.arch === "arm64" ? "mac-arm64" : "mac";
    return path.join(releaseDir, sub, "graph-manager.app", "Contents", "MacOS", "graph-manager");
  }
  if (process.platform === "win32") return path.join(releaseDir, "win-unpacked", "graph-manager.exe");
  // Linux (not a target; `npm run dist -- --linux dir`) names the binary after the package.
  return path.join(releaseDir, "linux-unpacked", "graph-manager-desktop");
}

/** Stops the run's own web process, which outlives the app by design. */
function stopPid(pid) {
  if (!pid || !pidAlive(pid)) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (process.platform === "win32") {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
    return new RegExp(`\\b${pid}\\b`).test(out);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

async function waitFor(what, timeoutMs, check) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(250);
  }
}

function expectStatus(what, res, ok) {
  if (!ok(res.status)) throw new Error(`${what}: unexpected HTTP ${res.status}`);
  console.log(`ok: ${what} -> ${res.status}`);
}

/** Opens the terminal's WebSocket, types the echo and resolves when the marker comes back. */
function terminalEcho(port, id, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers: { cookie } });
    let output = "";
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no "${MARKER}" from the terminal within ${ECHO_TIMEOUT_MS / 1000}s; output:\n${output}`));
    }, ECHO_TIMEOUT_MS);
    ws.on("open", () => ws.send(JSON.stringify({ type: "input", data: `echo ${MARKER}\r` })));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if ((msg.type === "data" || msg.type === "replay") && typeof msg.data === "string") {
        output += msg.data;
        // The terminal echoes the typed "echo gm-smoke-ok" too: only a line with the marker and no "echo" is output.
        // eslint-disable-next-line no-control-regex
        const plain = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
        if (plain.split(/[\r\n]+/).some((line) => line.includes(MARKER) && !line.includes("echo"))) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } else if (msg.type === "exit") {
        clearTimeout(timer);
        reject(new Error(`the terminal exited with code ${msg.code}; output:\n${output}`));
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`terminal WebSocket: ${err.message}`));
    });
  });
}

const bin = binaryPath();
if (!existsSync(bin)) {
  console.error(`FAIL: ${bin} is missing; run npm run dist -w graph-manager-desktop first`);
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "gm-desktop-smoke-"));
const dataDir = path.join(dir, "gm-data");
const wsDir = path.join(dir, "gm-ws");
mkdirSync(wsDir, { recursive: true });
const lockFile = path.join(dataDir, "server.lock");
// A workspace with one fake task, committed: graph-manager finds it as local~smoke~repo.
const repoDir = path.join(wsDir, "local", "smoke", "repo");
mkdirSync(path.join(repoDir, "tasks"), { recursive: true });
writeFileSync(path.join(repoDir, "tasks", "1.json"), JSON.stringify({ id: "1", content: "Smoke task.", dependencies: [] }));
writeFileSync(path.join(repoDir, "spec.md"), "# Smoke\n\nOne fake task.\n");
const git = (...args) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
git("init", "-q", "-b", "main");
git("config", "user.name", "gm-smoke");
git("config", "user.email", "gm-smoke@example.invalid");
git("add", "-A");
git("commit", "-q", "-m", "smoke");
let runWebPid = 0;
console.log(`smoke: starting ${bin} with user data ${dir}`);
// Linux is not a target, but the smoke test runs there too (under xvfb-run). Chromium refuses to run sandboxed as
// root, and on ubuntu-latest AppArmor blocks the unprivileged user namespaces its sandbox needs, so the Linux smoke
// run always goes without the Chromium sandbox. macOS and Windows keep it.
const extraArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
const child = spawn(bin, [`--user-data-dir=${dir}`, ...extraArgs], {
  env: { ...process.env, GM_DESKTOP_SMOKE: "1", GM_DATA_DIR: dataDir, GM_WORKSPACES_DIR: wsDir },
  stdio: "inherit",
});
let appExited = false;
const appExit = new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    appExited = true;
    resolve({ code, signal });
  });
  child.once("error", (err) => {
    appExited = true;
    resolve({ code: null, signal: null, error: err });
  });
});

let serverPid = 0;
try {
  const smokeFile = path.join(dir, "smoke.json");
  const result = await waitFor("smoke.json", START_TIMEOUT_MS, () => {
    if (appExited) throw new Error("the app exited before writing smoke.json");
    if (!existsSync(smokeFile)) return undefined;
    try {
      return JSON.parse(readFileSync(smokeFile, "utf8"));
    } catch {
      return undefined; // being written
    }
  });
  if (!result.ok) throw new Error(`the app reported a start error: ${result.error}`);
  const { port } = result;
  serverPid = result.serverPid;
  const cookie = `gm_session=${result.cookie}`;
  const base = `http://127.0.0.1:${port}`;
  console.log(`ok: smoke.json (port ${port}, server pid ${serverPid})`);

  expectStatus("GET /healthz", await fetch(`${base}/healthz`), (s) => s === 200);
  expectStatus("GET /api/health with the cookie", await fetch(`${base}/api/health`, { headers: { cookie } }), (s) => s === 200);
  expectStatus("GET /api/health without the cookie", await fetch(`${base}/api/health`), (s) => s === 401);

  const res = await fetch(`${base}/api/terminals`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`POST /api/terminals: HTTP ${res.status} ${await res.text()}`);
  const term = await res.json();
  if (typeof term.id !== "string") throw new Error(`POST /api/terminals: no id in ${JSON.stringify(term)}`);
  console.log(`ok: POST /api/terminals -> ${res.status} (id ${term.id})`);

  await terminalEcho(port, term.id, cookie);
  console.log(`ok: the terminal printed ${MARKER}`);

  const runRes = await fetch(`${base}/api/runs/local~smoke~repo`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ tasksDir: "tasks", spec: "spec.md", provider: "fake" }),
  });
  if (runRes.status !== 201) throw new Error(`POST /api/runs: HTTP ${runRes.status} ${await runRes.text()}`);
  const { runId } = await runRes.json();
  console.log(`ok: POST /api/runs -> 201 (run ${runId})`);
  const status = await waitFor(`run ${runId} to finish`, RUN_TIMEOUT_MS, async () => {
    const r = await fetch(`${base}/api/runs/local~smoke~repo/${runId}`, { headers: { cookie } });
    if (r.status !== 200) return undefined;
    const s = (await r.json()).summary?.status;
    return RUN_DONE.has(s) || RUN_FAILED.has(s) ? s : undefined;
  });
  try {
    runWebPid = JSON.parse(readFileSync(path.join(repoDir, ".graph-execution", runId, "web.json"), "utf8")).pid ?? 0;
  } catch {
    // the run process already closed its web view
  }
  if (!RUN_DONE.has(status)) throw new Error(`run ${runId} ended as ${status}`);
  console.log(`ok: run ${runId} ended as ${status}`);

  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  if (lock.port !== port || lock.pid !== serverPid) {
    throw new Error(`server.lock is ${JSON.stringify(lock)}, expected port ${port} and pid ${serverPid}`);
  }
  console.log("ok: server.lock matches");

  writeFileSync(path.join(dir, "smoke-quit"), "");
  await waitFor("the app to exit", QUIT_TIMEOUT_MS, () => appExited);
  await waitFor("server.lock to be removed", QUIT_TIMEOUT_MS, () => !existsSync(lockFile));
  await waitFor(`server pid ${serverPid} to exit`, QUIT_TIMEOUT_MS, () => !pidAlive(serverPid));
  console.log("ok: the app quit, server.lock is gone and the server process exited");

  stopPid(runWebPid);
  console.log("OK: desktop smoke passed");
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // a file still held open on Windows: the temp folder is the runner's
  }
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  for (const name of ["server.log", "main.log"]) {
    const file = path.join(dir, "logs", name);
    if (existsSync(file)) console.error(`--- ${file}\n${readFileSync(file, "utf8")}`);
  }
  if (!appExited) {
    if (process.platform === "win32" && child.pid) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // already gone
      }
    } else {
      child.kill("SIGKILL");
    }
    await Promise.race([appExit, sleep(5000)]);
  }
  stopPid(runWebPid);
  if (serverPid && pidAlive(serverPid)) {
    try {
      process.kill(serverPid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  process.exit(1);
}
