import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFakeBin } from "./fake-bin.js";

/**
 * A fake `docker` CLI (a node script) for the `--sandbox` tests.
 *
 * - Appends `{ argv, stdin, listing? }` for every call to `$FAKE_DOCKER_LOG` (JSONL).
 * - Keeps its images and containers in `$FAKE_DOCKER_STATE` (JSON: `{ images: [], containers: { <name>: {…} } }`);
 *   a container's home is `$FAKE_DOCKER_STATE.d/<name>/home`. `$FAKE_DOCKER_IMAGES` (comma-separated) are present too.
 * - `cp` records the listing of the source folder and copies its files into the container's home.
 * - `run … sh -c 'command -v <bin>'` fails for the bins in `$FAKE_DOCKER_MISSING_BINS` (comma-separated).
 * - Exec mode (`FAKE_DOCKER_EXEC=1`): `start` runs the container's command here, detached, with its `-e` env, HOME
 *   mapped to the container's home, `/opt/graph-execution` mapped to the engine copy, and the page on the published
 *   host port of 127.0.0.1. `inspect` says running while that process lives.
 * - A container's `running: false` in the state file (a test's edit) makes it exited.
 */
export const FAKE_DOCKER_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const argv = process.argv.slice(2);
const stateFile = process.env.FAKE_DOCKER_STATE;
const readState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { images: [], containers: {} }; }
};
const writeState = (s) => { fs.writeFileSync(stateFile + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(stateFile + ".tmp", stateFile); };
const homeOf = (name) => path.join(stateFile + ".d", name, "home");
const entry = { argv };
if (argv[0] === "build") entry.stdin = fs.readFileSync(0, "utf8");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const listing = (dir, rel = "") => {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { out.push(r + "/"); out.push(...listing(dir, r)); } else out.push(r);
  }
  return out.sort();
};
const done = (code = 0, stdout = "", stderr = "") => {
  if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(entry) + "\n");
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(code);
};
const s = readState();
s.images = s.images || [];
s.containers = s.containers || {};
const hasImage = (img) => s.images.includes(img) || (process.env.FAKE_DOCKER_IMAGES || "").split(",").includes(img);
const isRunning = (c) => {
  if (c.running === false || !c.started) return false;
  if (c.pid) return alive(c.pid);
  return true;
};
const VALUED = new Set(["--name", "--hostname", "--user", "--security-opt", "--cpus", "--memory", "--pids-limit", "-v", "-w", "-p", "--label", "-e"]);
switch (argv[0]) {
  case "version":
    done(0, "27.0.0");
  case "image": {
    const img = argv[argv.length - 1];
    if (!hasImage(img)) done(1, "", "Error: No such image: " + img);
    const format = argv[argv.indexOf("--format") + 1] || "";
    if (format.includes(".Config.Env")) done(0, JSON.stringify(["PATH=" + (process.env.FAKE_DOCKER_IMAGE_PATH || process.env.PATH)]));
    done(0, "sha256:fake");
  }
  case "build": {
    s.images.push(argv[argv.indexOf("-t") + 1]);
    writeState(s);
    done(0, "Step 1/5 : FROM fake");
  }
  case "run": {
    const cmd = argv[argv.length - 1];
    const bin = cmd.replace(/^command -v /, "");
    if ((process.env.FAKE_DOCKER_MISSING_BINS || "").split(",").includes(bin)) done(1);
    done(0, "/usr/local/bin/" + bin);
  }
  case "create": {
    const c = { env: [], mounts: [], ports: [], created: true };
    let i = 1;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--init") continue;
      if (!VALUED.has(a)) break;
      const v = argv[++i];
      if (a === "--name") c.name = v;
      else if (a === "-e") c.env.push(v);
      else if (a === "-v") c.mounts.push(v);
      else if (a === "-p") c.ports.push(v);
      else if (a === "-w") c.workdir = v;
      else if (a === "--hostname") c.hostname = v;
    }
    c.image = argv[i];
    c.cmd = argv.slice(i + 1);
    if (s.containers[c.name]) done(1, "", "Error: Conflict. The container name is already in use");
    s.containers[c.name] = c;
    fs.mkdirSync(homeOf(c.name), { recursive: true });
    writeState(s);
    done(0, "id-" + c.name);
  }
  case "cp": {
    const src = argv[argv.length - 2];
    const [name] = argv[argv.length - 1].split(":");
    if (!s.containers[name]) done(1, "", "Error: No such container: " + name);
    const dir = src.replace(/\/\.$/, "");
    entry.listing = listing(dir);
    fs.cpSync(dir, homeOf(name), { recursive: true });
    done(0);
  }
  case "start": {
    const name = argv[1];
    const c = s.containers[name];
    if (!c) done(1, "", "Error: No such container: " + name);
    c.started = true;
    c.running = true;
    if (process.env.FAKE_DOCKER_EXEC === "1") {
      const env = {};
      for (const kv of c.env) { const k = kv.slice(0, kv.indexOf("=")); env[k] = kv.slice(k.length + 1); }
      env.HOME = homeOf(name);
      const hostPort = /^127\.0\.0\.1:(\d+):7600$/.exec(c.ports[0] || "");
      env.GRAPH_EXECUTION_WEB_HOST = "127.0.0.1";
      if (hostPort) env.GRAPH_EXECUTION_WEB_PORT = hostPort[1];
      const engine = (c.mounts.find((m) => m.split(":")[1] === "/opt/graph-execution") || "").split(":")[0];
      const cmd = c.cmd.map((a) => a.replace(/^\/opt\/graph-execution/, engine));
      const log = fs.openSync(path.join(stateFile + ".d", name, "log"), "a");
      const child = spawn(cmd[0] === "node" ? process.execPath : cmd[0], cmd.slice(1), {
        cwd: c.workdir, env, detached: true, stdio: ["ignore", log, log],
      });
      c.pid = child.pid;
      child.unref();
    }
    writeState(s);
    done(0);
  }
  case "container": {
    const name = argv[argv.length - 1];
    const c = s.containers[name];
    if (!c) done(1, "", "Error: No such container: " + name);
    const running = isRunning(c);
    done(0, JSON.stringify({ Status: running ? "running" : c.started ? "exited" : "created", Running: running, ExitCode: running ? 0 : 1 }));
  }
  case "port": {
    const c = s.containers[argv[1]];
    if (!c) done(1, "", "Error: No such container: " + argv[1]);
    const m = /^127\.0\.0\.1:(\d+):/.exec(c.ports[0] || "");
    done(0, m ? "7600/tcp -> 127.0.0.1:" + m[1] : "");
  }
  case "logs": {
    const name = argv[argv.length - 1];
    if (!s.containers[name]) done(1, "", "Error: No such container: " + name);
    let text = "";
    try { text = fs.readFileSync(path.join(stateFile + ".d", name, "log"), "utf8"); } catch {}
    done(0, text.trimEnd() || "fake container log");
  }
  case "rm": {
    const name = argv[argv.length - 1];
    const c = s.containers[name];
    if (!c) done(1, "", "Error: No such container: " + name);
    if (isRunning(c) && !argv.includes("-f")) done(1, "", "Error: container is running");
    if (c.pid && alive(c.pid)) { try { process.kill(-c.pid, "SIGKILL"); } catch { try { process.kill(c.pid, "SIGKILL"); } catch {} } }
    delete s.containers[name];
    writeState(s);
    done(0, name);
  }
  default:
    done(1, "", "fake docker: unknown command " + argv.join(" "));
}
`;

/** Writes the fake `docker` into `binDir`; resolves with its path. */
export async function writeFakeDocker(binDir: string): Promise<string> {
  const file = path.join(binDir, "docker");
  await writeFakeBin(file, FAKE_DOCKER_SCRIPT);
  return file;
}

export interface DockerCall {
  argv: string[];
  stdin?: string;
  listing?: string[];
}

/** The calls in the fake's log. */
export async function dockerCalls(log: string): Promise<DockerCall[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as DockerCall);
}

export interface FakeContainer {
  name: string;
  env: string[];
  mounts: string[];
  ports: string[];
  hostname?: string;
  image: string;
  cmd: string[];
  started?: boolean;
  running?: boolean;
  pid?: number;
}

export interface FakeDockerState {
  images: string[];
  containers: Record<string, FakeContainer>;
}

export async function readFakeDockerState(file: string): Promise<FakeDockerState> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as FakeDockerState;
  } catch {
    return { images: [], containers: {} };
  }
}
