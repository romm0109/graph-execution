#!/usr/bin/env node
// A fake Docker Engine API on a unix socket, for tests and the live tester (KAN-88). No real Docker.
//
//   node apps/graph-manager/scripts/fake-docker.mjs <socketPath> [--exec] [--image <name>]... [--build-delay <ms>]
//
// It records every request and keeps containers, networks and volumes in memory. In `exec` mode a started
// container's Cmd runs as a local process (Linux only: each container gets a 127.0.0.<n> address).
// State for testers: curl --unix-socket <socketPath> http://x/__fake/state

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { URL, fileURLToPath } from "node:url";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendEmpty(res, status) {
  res.writeHead(status, { "content-length": 0 });
  res.end();
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  const text = buf.toString("utf8");
  if (text === "") return {};
  return JSON.parse(text);
}

function octal(buf, start, end) {
  const s = buf.subarray(start, end).toString("utf8").replace(/\0.*$/s, "").trim();
  return s === "" ? 0 : parseInt(s, 8);
}

function cstr(buf, start, end) {
  return buf.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
}

/**
 * Parses a tar archive (ustar, with GNU long names and pax `path` records).
 * @param {Buffer} buf
 * @returns {{ name: string, type: string, mode: number, data: Buffer }[]}
 */
export function parseTar(buf) {
  const entries = [];
  let i = 0;
  let longName;
  while (i + 512 <= buf.length) {
    const h = buf.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    let name = cstr(h, 0, 100);
    const prefix = h.subarray(257, 263).toString("utf8").startsWith("ustar") ? cstr(h, 345, 500) : "";
    if (prefix) name = `${prefix}/${name}`;
    const size = octal(h, 124, 136);
    const mode = octal(h, 100, 108);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(i + 512, i + 512 + size);
    i += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    if (longName !== undefined) {
      name = longName;
      longName = undefined;
    }
    entries.push({ name, type, mode, data });
  }
  return entries;
}

/**
 * Starts the fake Docker API.
 * @param {import("./fake-docker.d.mts").FakeDockerOptions} [opts]
 * @returns {Promise<import("./fake-docker.d.mts").FakeDocker>}
 */
export async function startFakeDocker({ socketPath, exec = false, images = [], self, buildDelayMs = 0 } = {}) {
  // Windows has no unix socket files to listen on: use a named pipe, which http.request's socketPath also takes.
  const name = `fake-docker-${randomBytes(4).toString("hex")}`;
  const sock = socketPath ?? (process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`));
  if (process.platform !== "win32" && existsSync(sock)) rmSync(sock, { force: true });

  /** @type {Map<string, any>} */
  const containers = new Map();
  /** @type {Map<string, { Id: string, Name: string, Driver: string, Containers: string[] }>} */
  const networks = new Map();
  /** @type {Map<string, { Name: string, Driver: string, Mountpoint: string, Labels: Record<string, string>, CreatedAt: string }>} */
  const volumes = new Map();
  const requests = [];
  /** @type {Map<string, import("node:child_process").ChildProcess>} */
  const children = new Map();
  /** @type {Map<string, Array<(code: number) => void>>} */
  const waiters = new Map();
  const newId = () => randomBytes(32).toString("hex");
  /** Image name (tag) → image. Several names may share one image (same Id). */
  /** @type {Map<string, { Id: string, Labels: Record<string, string>, Env: string[] }>} */
  const imageMap = new Map();
  const plainImage = () => ({ Id: `sha256:${newId()}`, Labels: {}, Env: [`PATH=${DEFAULT_PATH}`] });
  for (const n of images) imageMap.set(n, plainImage());
  /** @type {{ tag: string, nocache: boolean, labels: Record<string, string>, dockerfile: string }[]} */
  const builds = [];
  let nextIp = 2;

  const selfInfo = self
    ? {
        Id: self.id,
        Name: `/${self.name ?? "graph-manager"}`,
        Config: { Image: self.image ?? "graph-manager:dev", Hostname: self.id.slice(0, 12), Labels: {}, Env: [] },
        State: { Status: "running", Running: true, ExitCode: 0 },
        Mounts: self.mounts ?? [],
        HostConfig: {},
        networks: [...(self.networks ?? [])],
      }
    : undefined;

  /** The name and image for a name or an id (`sha256:<hex>`, or the hex alone). */
  function findImage(key) {
    const direct = imageMap.get(key);
    if (direct) return { name: key, image: direct };
    const id = key.startsWith("sha256:") ? key : `sha256:${key}`;
    for (const [name, image] of imageMap) if (image.Id === id) return { name, image };
    return undefined;
  }

  function imageNames(id) {
    return [...imageMap].filter(([, img]) => img.Id === id).map(([n]) => n);
  }

  function parseLabelFilters(query) {
    if (!query.filters) return [];
    return JSON.parse(query.filters).label ?? [];
  }

  function labelsMatch(labels, filters) {
    return filters.every((l) => {
      const eq = l.indexOf("=");
      const k = eq < 0 ? l : l.slice(0, eq);
      const has = Object.prototype.hasOwnProperty.call(labels ?? {}, k);
      return eq < 0 ? has : has && labels[k] === l.slice(eq + 1);
    });
  }

  function matches(c, key) {
    const k = key.replace(/^\//, "");
    return c.Id === key || (key.length >= 12 && c.Id.startsWith(key)) || c.Name === `/${k}`;
  }

  function findContainer(key) {
    for (const c of containers.values()) if (matches(c, key)) return c;
    return undefined;
  }

  function isSelf(key) {
    return selfInfo !== undefined && matches(selfInfo, key);
  }

  function selfInspect() {
    return {
      Id: selfInfo.Id,
      Name: selfInfo.Name,
      Config: selfInfo.Config,
      State: selfInfo.State,
      Mounts: selfInfo.Mounts,
      HostConfig: selfInfo.HostConfig,
      NetworkSettings: { Networks: Object.fromEntries(selfInfo.networks.map((n) => [n, { IPAddress: "127.0.0.1" }])) },
    };
  }

  function inspect(c) {
    return {
      Id: c.Id,
      Name: c.Name,
      Created: c.Created,
      Config: c.Config,
      HostConfig: c.HostConfig,
      State: c.State,
      Mounts: c.Mounts,
      NetworkSettings: { Networks: Object.fromEntries(c.networks.map((n) => [n, { IPAddress: c.ip }])) },
    };
  }

  function stateCopy(c) {
    return { ...inspect(c), NetworkingConfig: c.NetworkingConfig, archives: c.archives, logs: c.logs, ip: c.ip, root: c.root };
  }

  function exited(c, code) {
    c.State = { Status: "exited", Running: false, ExitCode: code };
    children.delete(c.Id);
    for (const fn of waiters.get(c.Id) ?? []) fn(code);
    waiters.delete(c.Id);
    if (c.HostConfig?.AutoRemove) removeContainer(c);
  }

  function removeContainer(c) {
    containers.delete(c.Id);
    for (const n of networks.values()) n.Containers = n.Containers.filter((id) => id !== c.Id);
    if (c.root) rmSync(c.root, { recursive: true, force: true });
    for (const fn of waiters.get(c.Id) ?? []) fn(c.State.ExitCode);
    waiters.delete(c.Id);
  }

  function kill(child, signal) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  /** Stops a running container: SIGTERM, then SIGKILL after `t` seconds. Resolves once it has exited. */
  function stop(c, t) {
    if (!c.State.Running) return Promise.resolve();
    const child = children.get(c.Id);
    if (!child) {
      exited(c, 0);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once("exit", () => resolve(undefined));
      kill(child, "SIGTERM");
      const timer = setTimeout(() => kill(child, "SIGKILL"), Math.max(0, t) * 1000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    });
  }

  /** Rewrites container paths through the bind mounts (Target → Source). */
  function bindRewrite(c, value) {
    let out = value;
    for (const m of c.HostConfig?.Mounts ?? []) {
      if (m.Type !== "bind" || !m.Target || !m.Source || m.Target === m.Source) continue;
      out = out.split(m.Target).join(m.Source);
    }
    return out;
  }

  function extract(c, at, entries) {
    const base = path.join(c.root, at);
    for (const e of entries) {
      const dest = path.join(base, e.name);
      if (!dest.startsWith(c.root)) continue;
      if (e.type === "5") {
        mkdirSync(dest, { recursive: true });
      } else if (e.type === "0" || e.type === "\0" || e.type === "7") {
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, e.data, { mode: e.mode || 0o644 });
      }
    }
  }

  function startExec(c) {
    const ip = c.ip;
    const env = {};
    for (const kv of c.Config.Env ?? []) {
      const eq = kv.indexOf("=");
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    if (env.GRAPH_EXECUTION_WEB_HOST === "0.0.0.0") env.GRAPH_EXECUTION_WEB_HOST = ip;
    env.HOME = c.root + (env.HOME ?? "/root");
    mkdirSync(env.HOME, { recursive: true });
    env.PATH = `${bindRewrite(c, env.PATH ?? DEFAULT_PATH)}:${process.env.PATH ?? ""}`;
    if (env.HOSTNAME === undefined) env.HOSTNAME = c.Config.Hostname;
    const cmd = (c.Config.Cmd ?? []).map((a) => bindRewrite(c, a));
    if (cmd.length === 0) {
      c.logs += "fake docker: no Cmd\n";
      exited(c, 127);
      return;
    }
    const bin = cmd[0] === "node" ? process.execPath : cmd[0];
    const cwd = c.Config.WorkingDir ? bindRewrite(c, c.Config.WorkingDir) : c.root;
    c.State = { Status: "running", Running: true, ExitCode: 0 };
    let child;
    try {
      child = spawn(bin, cmd.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      c.logs += `fake docker: ${err.message}\n`;
      exited(c, 127);
      return;
    }
    children.set(c.Id, child);
    child.stdout.on("data", (d) => (c.logs += d.toString("utf8")));
    child.stderr.on("data", (d) => (c.logs += d.toString("utf8")));
    let done = false;
    child.on("error", (err) => {
      c.logs += `fake docker: ${err.message}\n`;
      if (!done) {
        done = true;
        exited(c, 127);
      }
    });
    child.on("exit", (code, signal) => {
      if (done) return;
      done = true;
      exited(c, code ?? (signal === "SIGKILL" ? 137 : 143));
    });
  }

  function startPassive(c) {
    c.State = { Status: "running", Running: true, ExitCode: 0 };
    const cmd = c.Config.Cmd ?? [];
    if (cmd.length === 1 && cmd[0] === "true") {
      exited(c, 0);
      return;
    }
    const kv = (c.Config.Env ?? []).find((e) => e.startsWith("GRAPH_EXECUTION_READY_FILE="));
    if (kv) {
      const file = kv.slice("GRAPH_EXECUTION_READY_FILE=".length);
      const runKv = (c.Config.Env ?? []).find((e) => e.startsWith("GRAPH_EXECUTION_RUN_ID="));
      const runId = runKv ? runKv.slice("GRAPH_EXECUTION_RUN_ID=".length) : "";
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:7600/", runId, pid: 1 }));
      } catch (err) {
        c.logs += `fake docker: cannot write the ready file: ${err.message}\n`;
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://docker");
    const p = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, "");
    const query = Object.fromEntries(url.searchParams);
    const method = req.method ?? "GET";
    const raw = await readRaw(req);
    const isTar = (req.headers["content-type"] ?? "").includes("tar");
    let body;
    let tarEntries;
    if (isTar) {
      tarEntries = parseTar(raw);
      body = { tarEntries: tarEntries.map((e) => e.name) };
    } else {
      try {
        body = parseJson(raw);
      } catch {
        return sendJson(res, 400, { message: "invalid JSON" });
      }
    }
    if (!p.startsWith("/__fake/")) requests.push({ method, path: p, query, body });

    if (method === "GET" && p === "/_ping") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": 2 });
      return res.end("OK");
    }
    if (method === "GET" && p === "/__fake/state") {
      return sendJson(res, 200, {
        containers: [...containers.values()].map(stateCopy),
        networks: [...networks.values()],
        volumes: [...volumes.values()],
        builds,
        images: [...imageMap].map(([n, img]) => ({ name: n, Id: img.Id, Labels: img.Labels })),
      });
    }

    // containers
    if (method === "GET" && p === "/containers/json") {
      let labels;
      try {
        labels = parseLabelFilters(query);
      } catch {
        return sendJson(res, 400, { message: "invalid filters" });
      }
      const all = query.all === "1" || query.all === "true";
      const list = [...containers.values()].filter((c) => (all || c.State.Running) && labelsMatch(c.Config.Labels, labels));
      return sendJson(
        res,
        200,
        list.map((c) => ({ Id: c.Id, Names: [c.Name], Image: c.Config.Image, Labels: c.Config.Labels ?? {}, State: c.State.Status })),
      );
    }
    if (method === "POST" && p === "/containers/create") {
      const name = query.name || `fake_${randomBytes(4).toString("hex")}`;
      if (findContainer(name) || isSelf(name)) {
        return sendJson(res, 409, { message: `Conflict. The container name "/${name}" is already in use` });
      }
      const Id = newId();
      const hc = body.HostConfig ?? {};
      const networkMode = hc.NetworkMode || "bridge";
      const c = {
        Id,
        Name: `/${name}`,
        Created: new Date().toISOString(),
        Config: {
          Image: body.Image,
          Hostname: body.Hostname || Id.slice(0, 12),
          Labels: body.Labels ?? {},
          Env: body.Env ?? [],
          Cmd: body.Cmd ?? [],
          WorkingDir: body.WorkingDir ?? "",
          User: body.User ?? "",
        },
        HostConfig: hc,
        NetworkingConfig: body.NetworkingConfig ?? {},
        State: { Status: "created", Running: false, ExitCode: 0 },
        Mounts: (hc.Mounts ?? []).map((m) => ({
          Type: m.Type,
          ...(m.Type === "volume" ? { Name: m.Source } : {}),
          Source: m.Source,
          Destination: m.Target,
          RW: !m.ReadOnly,
        })),
        archives: [],
        logs: "",
        ip: `127.0.0.${nextIp++}`,
        networks: [networkMode],
        root: undefined,
      };
      if (exec) {
        c.root = path.join(os.tmpdir(), `fake-docker-root-${Id.slice(0, 12)}`);
        mkdirSync(c.root, { recursive: true });
      }
      containers.set(Id, c);
      const net = networks.get(networkMode);
      if (net) net.Containers.push(Id);
      return sendJson(res, 201, { Id, Warnings: [] });
    }
    let m = /^\/containers\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const action = m[2] ?? "";
      if (method === "GET" && action === "/json" && isSelf(key)) return sendJson(res, 200, selfInspect());
      const c = findContainer(key);
      if (!c) return sendJson(res, 404, { message: `No such container: ${key}` });
      if (method === "GET" && action === "/json") return sendJson(res, 200, inspect(c));
      if (method === "PUT" && action === "/archive") {
        const at = query.path ?? "/";
        c.archives.push({ path: at, names: body.tarEntries });
        if (exec && c.root) extract(c, at, tarEntries);
        return sendEmpty(res, 200);
      }
      if (method === "POST" && action === "/start") {
        if (c.State.Running) return sendEmpty(res, 304);
        if (exec) startExec(c);
        else startPassive(c);
        return sendEmpty(res, 204);
      }
      if (method === "POST" && action === "/stop") {
        if (!c.State.Running) return sendEmpty(res, 304);
        await stop(c, query.t !== undefined ? Number(query.t) : 10);
        return sendEmpty(res, 204);
      }
      if (method === "POST" && action === "/wait") {
        if (!c.State.Running) return sendJson(res, 200, { StatusCode: c.State.ExitCode, Error: null });
        const list = waiters.get(c.Id) ?? [];
        list.push((code) => sendJson(res, 200, { StatusCode: code, Error: null }));
        waiters.set(c.Id, list);
        return;
      }
      if (method === "GET" && action === "/logs") {
        let lines = c.logs.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        const tail = query.tail === undefined || query.tail === "all" ? undefined : Number(query.tail);
        if (tail !== undefined && Number.isFinite(tail)) lines = tail <= 0 ? [] : lines.slice(-tail);
        const frames = lines.map((line) => {
          const data = Buffer.from(`${line}\n`, "utf8");
          const head = Buffer.alloc(8);
          head[0] = 1;
          head.writeUInt32BE(data.length, 4);
          return Buffer.concat([head, data]);
        });
        const out = Buffer.concat(frames);
        res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream", "content-length": out.length });
        return res.end(out);
      }
      if (method === "DELETE" && action === "") {
        if (c.State.Running) {
          if (query.force !== "1" && query.force !== "true") {
            return sendJson(res, 409, { message: `cannot remove container "${c.Name}": container is running: stop the container before removing or force remove` });
          }
          const child = children.get(c.Id);
          if (child) {
            await new Promise((resolve) => {
              child.once("exit", () => resolve(undefined));
              kill(child, "SIGKILL");
            });
          } else {
            exited(c, 137);
          }
        }
        if (containers.has(c.Id)) removeContainer(c);
        return sendEmpty(res, 204);
      }
    }

    // networks
    if (method === "POST" && p === "/networks/create") {
      const name = body.Name;
      if (networks.has(name)) return sendJson(res, 409, { message: `network with name ${name} already exists` });
      const net = { Id: newId(), Name: name, Driver: body.Driver ?? "bridge", Containers: [] };
      networks.set(name, net);
      return sendJson(res, 201, { Id: net.Id, Warning: "" });
    }
    m = /^\/networks\/([^/]+)(\/connect)?$/.exec(p);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const net = networks.get(key) ?? [...networks.values()].find((n) => n.Id === key || (key.length >= 12 && n.Id.startsWith(key)));
      if (!net) return sendJson(res, 404, { message: `network ${key} not found` });
      if (method === "GET" && !m[2]) {
        return sendJson(res, 200, { Id: net.Id, Name: net.Name, Driver: net.Driver, Containers: Object.fromEntries(net.Containers.map((id) => [id, {}])) });
      }
      if (method === "POST" && m[2]) {
        const target = String(body.Container ?? "");
        if (isSelf(target)) {
          if (selfInfo.networks.includes(net.Name)) {
            return sendJson(res, 403, { message: `endpoint with name ${selfInfo.Name.slice(1)} already exists in network ${net.Name}` });
          }
          selfInfo.networks.push(net.Name);
          net.Containers.push(selfInfo.Id);
          return sendEmpty(res, 200);
        }
        const c = findContainer(target);
        if (!c) return sendJson(res, 404, { message: `No such container: ${target}` });
        if (c.networks.includes(net.Name)) return sendJson(res, 403, { message: `endpoint with name ${c.Name.slice(1)} already exists in network ${net.Name}` });
        c.networks.push(net.Name);
        net.Containers.push(c.Id);
        return sendEmpty(res, 200);
      }
    }

    // volumes
    if (method === "POST" && p === "/volumes/create") {
      const name = body.Name || newId();
      let vol = volumes.get(name);
      if (!vol) {
        vol = { Name: name, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Labels: body.Labels ?? {}, CreatedAt: new Date().toISOString() };
        volumes.set(name, vol);
      }
      return sendJson(res, 201, vol);
    }
    if (method === "GET" && p === "/volumes") {
      let labels;
      try {
        labels = parseLabelFilters(query);
      } catch {
        return sendJson(res, 400, { message: "invalid filters" });
      }
      return sendJson(res, 200, { Volumes: [...volumes.values()].filter((v) => labelsMatch(v.Labels, labels)), Warnings: null });
    }
    m = /^\/volumes\/([^/]+)$/.exec(p);
    if (m && method === "GET") {
      const name = decodeURIComponent(m[1]);
      const vol = volumes.get(name);
      return vol ? sendJson(res, 200, vol) : sendJson(res, 404, { message: `get ${name}: no such volume` });
    }
    if (m && method === "DELETE") {
      const name = decodeURIComponent(m[1]);
      if (!volumes.has(name)) return sendJson(res, 404, { message: `get ${name}: no such volume` });
      const users = [...containers.values()].filter((c) => c.Mounts.some((mt) => mt.Name === name));
      if (users.length > 0) return sendJson(res, 409, { message: `remove ${name}: volume is in use - [${users.map((c) => c.Id).join(", ")}]` });
      volumes.delete(name);
      return sendEmpty(res, 204);
    }

    // images: a pull of a name with "missing" in it fails in the progress stream, like Docker's 200 + error line.
    if (method === "POST" && p === "/images/create") {
      const name = String(query.fromImage ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      if (name.includes("missing")) return res.end(`${JSON.stringify({ status: "Pulling" })}\n${JSON.stringify({ error: `manifest for ${name} not found` })}\n`);
      if (!imageMap.has(name)) imageMap.set(name, plainImage());
      return res.end(`${JSON.stringify({ status: `Downloaded newer image for ${name}` })}\n`);
    }
    // build: a Dockerfile with FAKE_BUILD_FAIL in it fails in the stream; each build makes a new image id.
    if (method === "POST" && p === "/build") {
      const entry = (tarEntries ?? []).find((e) => e.name === "Dockerfile" || e.name === "./Dockerfile");
      const dockerfile = entry ? entry.data.toString("utf8") : "";
      const tag = String(query.t ?? "");
      let labels;
      try {
        labels = JSON.parse(query.labels ?? "{}");
      } catch {
        return sendJson(res, 400, { message: "invalid labels" });
      }
      builds.push({ tag, nocache: query.nocache === "1" || query.nocache === "true", labels, dockerfile });
      const lines = dockerfile.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      res.writeHead(200, { "content-type": "application/json" });
      lines.forEach((l, i) => res.write(`${JSON.stringify({ stream: `Step ${i + 1}/${lines.length} : ${l}\n` })}\n`));
      if (buildDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, buildDelayMs));
      if (dockerfile.includes("FAKE_BUILD_FAIL")) {
        return res.end(`${JSON.stringify({ errorDetail: { message: "fake build failed" }, error: "fake build failed" })}\n`);
      }
      let pathValue = DEFAULT_PATH;
      for (const l of lines) if (l.startsWith("ENV PATH=")) pathValue = l.slice("ENV PATH=".length).split("$PATH").join(DEFAULT_PATH);
      const image = { Id: `sha256:${newId()}`, Labels: labels, Env: [`PATH=${pathValue}`] };
      if (tag !== "") imageMap.set(tag, image);
      res.write(`${JSON.stringify({ aux: { ID: image.Id } })}\n`);
      return res.end(`${JSON.stringify({ stream: `Successfully tagged ${tag}\n` })}\n`);
    }
    // images
    if (method === "GET" && p === "/images/json") {
      let labels;
      try {
        labels = parseLabelFilters(query);
      } catch {
        return sendJson(res, 400, { message: "invalid filters" });
      }
      const byId = new Map();
      for (const [n, img] of imageMap) {
        if (!labelsMatch(img.Labels, labels)) continue;
        const entry = byId.get(img.Id) ?? { Id: img.Id, RepoTags: [], Labels: img.Labels };
        entry.RepoTags.push(n);
        byId.set(img.Id, entry);
      }
      return sendJson(res, 200, [...byId.values()]);
    }
    m = /^\/images\/(.+)\/json$/.exec(p);
    if (m && method === "GET") {
      const name = decodeURIComponent(m[1]);
      const found = findImage(name);
      if (!found) return sendJson(res, 404, { message: `No such image: ${name}` });
      const { image } = found;
      return sendJson(res, 200, { Id: image.Id, RepoTags: imageNames(image.Id), Config: { Env: image.Env, Labels: image.Labels } });
    }
    m = /^\/images\/(.+)$/.exec(p);
    if (m && method === "DELETE") {
      const name = decodeURIComponent(m[1]);
      const found = findImage(name);
      if (!found) return sendJson(res, 404, { message: `No such image: ${name}` });
      const id = found.image.Id;
      const refs = new Set([name, id, id.slice("sha256:".length), ...imageNames(id)]);
      const user = [...containers.values()].find((c) => refs.has(c.Config.Image));
      if (user) {
        return sendJson(res, 409, { message: `conflict: unable to delete ${name} (cannot be forced) - image is being used by running container ${user.Id.slice(0, 12)}` });
      }
      for (const n of imageNames(id)) imageMap.delete(n);
      return sendJson(res, 200, [{ Deleted: id }]);
    }

    return sendJson(res, 404, { message: `page not found: ${method} ${p}` });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { message: String(err?.message ?? err) });
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => resolve(undefined));
  });

  return {
    socketPath: sock,
    requests,
    containers,
    networks,
    volumes,
    builds,
    images: imageMap,
    close: async () => {
      for (const child of children.values()) kill(child, "SIGKILL");
      children.clear();
      for (const c of containers.values()) if (c.root) rmSync(c.root, { recursive: true, force: true });
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      });
      if (process.platform !== "win32") rmSync(sock, { force: true });
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let socketPath;
  let execMode = false;
  const images = [];
  let buildDelayMs = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--exec") execMode = true;
    else if (a === "--image") images.push(args[++i]);
    else if (a === "--build-delay") buildDelayMs = Number(args[++i]) || 0;
    else if (socketPath === undefined) socketPath = a;
  }
  const docker = await startFakeDocker({ socketPath, exec: execMode, images, buildDelayMs });
  console.log(`fake docker listening on ${docker.socketPath}`);
  const stop = () => {
    void docker.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
