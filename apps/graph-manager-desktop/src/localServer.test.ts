import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledPaths } from "./paths.js";
import {
  AlreadyRunning,
  localDataDir,
  localWorkspacesDir,
  loginCookie,
  logTail,
  readLocalPassword,
  rotateLog,
  serverEnv,
  startLocalServer,
  type RunningServer,
} from "./localServer.js";

let tmp: string;
let entry: string;
let cli: string;
const started: RunningServer[] = [];

beforeAll(async () => {
  ({ serverEntry: entry, graphExecutionCli: cli } = bundledPaths({ packaged: false }));
  if (!existsSync(entry)) throw new Error(`${entry} is missing: run npm run build -w graph-manager first`);
  tmp = await mkdtemp(path.join(os.tmpdir(), "gmd-ls-"));
});

afterAll(async () => {
  await Promise.all(started.map((s) => s.stop()));
  await rm(tmp, { recursive: true, force: true });
});

function opts(name: string, extra: Partial<Parameters<typeof startLocalServer>[0]> = {}) {
  const data = path.join(tmp, name, "data");
  return {
    serverEntry: entry,
    graphExecutionCli: cli,
    dataDir: data,
    logFile: path.join(tmp, name, "logs", "server.log"),
    execPath: process.execPath,
    electron: false,
    env: {
      ...process.env,
      GM_DATA_DIR: data,
      GM_WORKSPACES_DIR: path.join(tmp, name, "ws"),
      GM_DOCKER_SOCKET: path.join(tmp, "none.sock"),
      GM_PASSWORD: "ignored",
    },
    ...extra,
  };
}

async function start(o: Parameters<typeof startLocalServer>[0]): Promise<RunningServer> {
  const s = await startLocalServer(o);
  started.push(s);
  return s;
}

describe("startLocalServer", { timeout: 60000 }, () => {
  it("starts the real server, logs in with its password file and stops cleanly", async () => {
    const o = opts("a");
    const s = await start(o);
    expect(s.port).toBeGreaterThan(0);
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
    expect((await fetch(`${s.origin}/healthz`)).status).toBe(200);

    const pw = readLocalPassword(o.dataDir);
    expect(pw).not.toBe("ignored");
    const value = await loginCookie(s.origin, pw);
    expect(value).not.toBe("");
    expect((await fetch(`${s.origin}/api/health`, { headers: { cookie: `gm_session=${value}` } })).status).toBe(200);
    expect((await fetch(`${s.origin}/api/health`)).status).toBe(401);
    await expect(loginCookie(s.origin, "wrong")).rejects.toThrow(/HTTP 401/);

    const lock = path.join(o.dataDir, "server.lock");
    expect(existsSync(lock)).toBe(true);
    await s.stop();
    await expect(fetch(`${s.origin}/healthz`)).rejects.toThrow();
    expect(existsSync(lock)).toBe(false);
    expect(await readFile(o.logFile, "utf8")).toContain("listening");
  });

  it("rejects with AlreadyRunning when a server runs on the data folder", async () => {
    const first = await start(opts("b"));
    const o2 = opts("b", { logFile: path.join(tmp, "b", "logs", "second.log") });
    const err = await startLocalServer(o2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyRunning);
    expect((err as AlreadyRunning).port).toBe(first.port);
    expect((err as AlreadyRunning).pid).toBe(first.pid);
    // The first server is untouched.
    expect((await fetch(`${first.origin}/healthz`)).status).toBe(200);
    await first.stop();
  });

  it("rejects with the log tail when the entry file is missing", async () => {
    await expect(startLocalServer(opts("c", { serverEntry: path.join(tmp, "nope.js") }))).rejects.toThrow(
      /graph-manager did not start/,
    );
  });
});

describe("serverEnv", () => {
  it("strips the password and port and sets the local-mode variables", () => {
    const env = serverEnv({ GM_PORT: "1", GM_PASSWORD: "x", PATH: "/a" }, "/c.js", false);
    expect(env).toEqual({ PATH: "/a", GM_PORT_FALLBACK: "1", GM_HOST: "127.0.0.1", GM_GRAPH_EXECUTION_BIN: "/c.js" });
    expect("GM_DATA_DIR" in env).toBe(false);
    expect("GM_WORKSPACES_DIR" in env).toBe(false);
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
  });

  it("adds ELECTRON_RUN_AS_NODE under Electron and passes the folders through", () => {
    const env = serverEnv({ GM_DATA_DIR: "/d", GM_WORKSPACES_DIR: "/w" }, "/c.js", true);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.GM_DATA_DIR).toBe("/d");
    expect(env.GM_WORKSPACES_DIR).toBe("/w");
  });
});

describe("local folders", () => {
  const home = path.join(os.tmpdir(), "home");
  it("defaults to the server's folders under home", () => {
    expect(localDataDir({}, home)).toBe(path.join(home, ".graph-manager"));
    expect(localWorkspacesDir({}, home)).toBe(path.join(home, "graph-manager-workspaces"));
  });
  it("uses the env variables, resolved", () => {
    expect(localDataDir({ GM_DATA_DIR: "rel/d" }, home)).toBe(path.resolve("rel/d"));
    expect(localWorkspacesDir({ GM_WORKSPACES_DIR: "rel/w" }, home)).toBe(path.resolve("rel/w"));
  });
});

describe("readLocalPassword", () => {
  it("trims the file and throws when it is missing or blank", async () => {
    const dir = path.join(tmp, "pw");
    expect(() => readLocalPassword(dir)).toThrow(`no password file in ${dir}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "password"), "  \n");
    expect(() => readLocalPassword(dir)).toThrow(/no password file/);
    await writeFile(path.join(dir, "password"), "secret\n");
    expect(readLocalPassword(dir)).toBe("secret");
  });
});

describe("loginCookie", () => {
  it("takes the gm_session value from Set-Cookie", async () => {
    const fake = (async () =>
      new Response(null, {
        status: 204,
        headers: [
          ["set-cookie", "other=1; Path=/"],
          ["set-cookie", "gm_session=abc.def; HttpOnly; Path=/"],
        ],
      })) as typeof fetch;
    expect(await loginCookie("http://x", "p", fake)).toBe("abc.def");
  });
  it("throws on 429 and on 204 without the cookie", async () => {
    await expect(loginCookie("http://x", "p", (async () => new Response(null, { status: 429 })) as typeof fetch)).rejects.toThrow(
      "login failed: HTTP 429",
    );
    await expect(loginCookie("http://x", "p", (async () => new Response(null, { status: 204 })) as typeof fetch)).rejects.toThrow(
      "login failed: HTTP 204",
    );
  });
});

describe("logTail and rotateLog", () => {
  it("returns the last lines, or '' when missing", async () => {
    const f = path.join(tmp, "tail.log");
    expect(logTail(f)).toBe("");
    await writeFile(f, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(logTail(f, 2)).toBe("line 28\nline 29");
    expect(logTail(f).split("\n")).toHaveLength(20);
  });

  it("renames a large file to .1 and keeps a small one", async () => {
    const f = path.join(tmp, "rot.log");
    await writeFile(f, "small");
    rotateLog(f, 10);
    expect(existsSync(f)).toBe(true);
    await writeFile(`${f}.1`, "older");
    await writeFile(f, "x".repeat(20));
    rotateLog(f, 10);
    expect(existsSync(f)).toBe(false);
    expect(await readFile(`${f}.1`, "utf8")).toBe("x".repeat(20));
    rotateLog(path.join(tmp, "missing.log"));
  });
});
