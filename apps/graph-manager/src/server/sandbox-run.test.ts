import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContainerInfo } from "./docker.js";
import { execa } from "execa";
import { containerBody, loginEntries, repoMounts, SandboxError, sandboxEnv, windowsGitConfig, workspaceMount } from "./sandbox-run.js";
import { tempDir } from "./test-helpers.js";
import type { Workspace } from "./workspaces.js";

const ws: Workspace = { id: "github~octo~hello", path: "/workspaces/github/octo/hello", rel: "github/octo/hello", forge: "github", fullPath: "octo/hello" };

function selfWith(mounts: ContainerInfo["Mounts"]): ContainerInfo {
  return {
    Id: "abc",
    Name: "/gm",
    Config: { Image: "gm:dev", Hostname: "abc" },
    State: { Status: "running", Running: true, ExitCode: 0 },
    Mounts: mounts,
  };
}

describe("sandboxEnv", () => {
  const base = {
    GM_PASSWORD: "secret",
    GM_PORT: "8080",
    GITHUB_TOKEN: "ghp_x",
    HOME: "/data/home",
    PATH: "/usr/bin",
    HOSTNAME: "gm",
    ANTHROPIC_API_KEY: "sk-ant",
    GRAPH_EXECUTION_REVIEWERS_FILE: "/r.json",
    GRAPH_EXECUTION_RUNS_ROOT: "/elsewhere",
    GRAPH_EXECUTION_HANDOFF: "detached",
    GRAPH_EXECUTION_WEB_TOKEN: "graph-manager-own",
    TZ: "UTC",
  };

  it("passes only the allowed variables and sets the sandbox ones", () => {
    const env = sandboxEnv(base, { runId: "gm-1", runDir: "/w/.graph-execution/gm-1", image: "img:1", token: "tok" });
    expect(env.filter((e) => e.startsWith("GM_"))).toEqual([]);
    expect(env.some((e) => e.startsWith("GITHUB_TOKEN="))).toBe(false);
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant");
    expect(env).toContain("GRAPH_EXECUTION_REVIEWERS_FILE=/r.json");
    expect(env).toContain("TZ=UTC");
    expect(env.some((e) => e.startsWith("GRAPH_EXECUTION_RUNS_ROOT="))).toBe(false);
    expect(env.some((e) => e.startsWith("GRAPH_EXECUTION_HANDOFF="))).toBe(false);
    expect(env.some((e) => e.startsWith("HOSTNAME="))).toBe(false);
    expect(env.filter((e) => e.startsWith("HOME="))).toEqual(["HOME=/home/sandbox"]);
    expect(env.filter((e) => e.startsWith("PATH="))).toEqual(["PATH=/opt/gm-tools/bin:/opt/gm-clis/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]);
    expect(env).toEqual(
      expect.arrayContaining([
        "GRAPH_EXECUTION_SANDBOX=1",
        "GRAPH_EXECUTION_SANDBOX_IMAGE=img:1",
        "GRAPH_EXECUTION_RUN_ID=gm-1",
        "GRAPH_EXECUTION_WEB_HOST=0.0.0.0",
        "GRAPH_EXECUTION_WEB_PORT=7600",
        "GRAPH_EXECUTION_WEB_TOKEN=tok",
        "GRAPH_EXECUTION_READY_FILE=/w/.graph-execution/gm-1/.ready.json",
      ]),
    );
    expect(env.some((e) => e.startsWith("GRAPH_EXECUTION_TAKE_LOCK_FROM="))).toBe(false);
  });

  it("sets TAKE_LOCK_FROM when given and the git identity when the env lacks it", () => {
    const env = sandboxEnv(
      { GIT_AUTHOR_NAME: "Env Name" },
      { runId: "gm-1", runDir: "/r", image: "i", token: "t", takeLockFrom: "sbx-1", gitIdentity: { GIT_AUTHOR_NAME: "Git", GIT_AUTHOR_EMAIL: "g@x" } },
    );
    expect(env).toContain("GRAPH_EXECUTION_TAKE_LOCK_FROM=sbx-1");
    expect(env.filter((e) => e.startsWith("GIT_AUTHOR_NAME="))).toEqual(["GIT_AUTHOR_NAME=Env Name"]);
    expect(env).toContain("GIT_AUTHOR_EMAIL=g@x");
  });

  it("ends with the git settings as GIT_CONFIG_* when given", () => {
    const p = { runId: "gm-1", runDir: "/r", image: "i", token: "t", takeLockFrom: "sbx-1" };
    const env = sandboxEnv(base, {
      ...p,
      gitConfig: [
        ["safe.directory", "*"],
        ["core.filemode", "false"],
        ["core.autocrlf", "true"],
      ],
    });
    expect(env.slice(-7)).toEqual([
      "GIT_CONFIG_COUNT=3",
      "GIT_CONFIG_KEY_0=safe.directory",
      "GIT_CONFIG_VALUE_0=*",
      "GIT_CONFIG_KEY_1=core.filemode",
      "GIT_CONFIG_VALUE_1=false",
      "GIT_CONFIG_KEY_2=core.autocrlf",
      "GIT_CONFIG_VALUE_2=true",
    ]);
    expect(env.filter((e) => e.startsWith("GIT_CONFIG_"))).toHaveLength(7);
    // Never from graph-manager's own env, and nothing without settings.
    const own = { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" };
    expect(sandboxEnv(own, p).filter((e) => e.startsWith("GIT_CONFIG_"))).toEqual([]);
    expect(sandboxEnv(own, { ...p, gitConfig: [] }).filter((e) => e.startsWith("GIT_CONFIG_"))).toEqual([]);
  });
});

describe("windowsGitConfig", () => {
  it("allows the foreign-owned checkout, ignores file modes and passes core.autocrlf when it is set", async () => {
    const { dir, cleanup } = await tempDir();
    const saved = { ...process.env };
    try {
      // Only the repo's own config counts here: vitest.config.ts sets core.autocrlf through GIT_CONFIG_* on Windows,
      // and the machine's global or system config may set it too.
      const empty = path.join(dir, "gitconfig");
      await writeFile(empty, "");
      for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG_")) delete process.env[k];
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.GIT_CONFIG_GLOBAL = empty;
      const repo = path.join(dir, "repo");
      await mkdir(repo);
      await execa("git", ["init", "-q"], { cwd: repo });
      expect(await windowsGitConfig(repo)).toEqual([
        ["safe.directory", "*"],
        ["core.filemode", "false"],
      ]);
      await execa("git", ["config", "core.autocrlf", "input"], { cwd: repo });
      expect(await windowsGitConfig(repo)).toEqual([
        ["safe.directory", "*"],
        ["core.filemode", "false"],
        ["core.autocrlf", "input"],
      ]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      await cleanup();
    }
  });
});

describe("workspaceMount", () => {
  it("uses the override: an absolute path or a volume", () => {
    expect(workspaceMount(ws, "/workspaces", undefined, "/srv/ws", "linux")).toEqual({ Type: "bind", Source: "/srv/ws/github/octo/hello", Target: ws.path });
    expect(workspaceMount(ws, "/workspaces", undefined, "gm-ws", "linux")).toEqual({
      Type: "volume",
      Source: "gm-ws",
      Target: ws.path,
      VolumeOptions: { Subpath: "github/octo/hello" },
    });
  });

  it("on a Windows host takes a Windows path override as a bind source", () => {
    const win = { ...ws, path: "C:\\ws\\github\\octo\\hello" };
    expect(workspaceMount(win, "C:\\ws", undefined, "D:\\src\\ws", "win32")).toEqual({
      Type: "bind",
      Source: "D:\\src\\ws\\github\\octo\\hello",
      Target: "/workspaces/github/octo/hello",
    });
    expect(workspaceMount(win, "C:\\ws", undefined, "gm-ws", "win32")).toMatchObject({ Type: "volume", Source: "gm-ws" });
  });

  it("derives the source from graph-manager's own mount", () => {
    const vol = selfWith([{ Type: "volume", Name: "gm-workspaces", Source: "/var/lib/docker/volumes/gm-workspaces/_data", Destination: "/workspaces" }]);
    expect(workspaceMount(ws, "/workspaces", vol)).toEqual({
      Type: "volume",
      Source: "gm-workspaces",
      Target: ws.path,
      VolumeOptions: { Subpath: "github/octo/hello" },
    });
    const bind = selfWith([{ Type: "bind", Source: "/home/me/ws", Destination: "/workspaces" }]);
    expect(workspaceMount(ws, "/workspaces", bind)).toEqual({ Type: "bind", Source: "/home/me/ws/github/octo/hello", Target: ws.path });
    expect(() => workspaceMount(ws, "/workspaces", selfWith([]))).toThrow(SandboxError);
    expect(() => workspaceMount(ws, "/workspaces", selfWith([]))).toThrow(/GM_SANDBOX_WORKSPACES_SOURCE/);
  });

  it("binds the workspace path itself outside Docker", () => {
    expect(workspaceMount(ws, "/workspaces", undefined)).toEqual({ Type: "bind", Source: ws.path, Target: ws.path });
    expect(workspaceMount(ws, "/workspaces", undefined, undefined, "linux")).toEqual({ Type: "bind", Source: ws.path, Target: ws.path });
  });

  it("mounts at /workspaces/<rel> on win32", () => {
    const win: Workspace = { ...ws, path: "C:\\Users\\Me\\gm-ws\\github\\octo\\hello" };
    expect(workspaceMount(win, "C:\\Users\\Me\\gm-ws", undefined, undefined, "win32")).toEqual({
      Type: "bind",
      Source: win.path,
      Target: "/workspaces/github/octo/hello",
    });
    expect(workspaceMount(win, "C:\\Users\\Me\\gm-ws", undefined, "gm-ws", "win32")).toEqual({
      Type: "volume",
      Source: "gm-ws",
      Target: "/workspaces/github/octo/hello",
      VolumeOptions: { Subpath: "github/octo/hello" },
    });
  });
});

describe("repoMounts", () => {
  const home: Workspace = { id: "project~billing", path: "/ws/.projects/billing", rel: ".projects/billing", forge: "project", fullPath: "billing" };
  const api: Workspace = { id: "github~acme~api", path: "/ws/github/acme/api", rel: "github/acme/api", forge: "github", fullPath: "acme/api" };
  const web: Workspace = { id: "github~acme~web", path: "/ws/github/acme/web", rel: "github/acme/web", forge: "github", fullPath: "acme/web" };
  const links = ["repos/api", "repos/web"];

  it("mounts each repo at its own path off Windows, with no mount under repos/", () => {
    expect(repoMounts(home, [api, web], links, "/ws", undefined, undefined, "linux")).toEqual([
      { Type: "bind", Source: api.path, Target: api.path },
      { Type: "bind", Source: web.path, Target: web.path },
    ]);
  });

  it("on a Windows host also mounts each repo over its junction in the project folder", () => {
    const winHome = { ...home, path: "C:\\ws\\.projects\\billing" };
    const winApi = { ...api, path: "C:\\ws\\github\\acme\\api" };
    const winWeb = { ...web, path: "C:\\ws\\github\\acme\\web" };
    expect(repoMounts(winHome, [winApi, winWeb], links, "C:\\ws", undefined, undefined, "win32")).toEqual([
      { Type: "bind", Source: winApi.path, Target: "/workspaces/github/acme/api" },
      { Type: "bind", Source: winApi.path, Target: "/workspaces/.projects/billing/repos/api" },
      { Type: "bind", Source: winWeb.path, Target: "/workspaces/github/acme/web" },
      { Type: "bind", Source: winWeb.path, Target: "/workspaces/.projects/billing/repos/web" },
    ]);
  });

  it("takes each repo's own subpath of graph-manager's volume", () => {
    const vol = selfWith([{ Type: "volume", Name: "gm-workspaces", Source: "/var/lib/docker/volumes/gm-workspaces/_data", Destination: "/ws" }]);
    expect(repoMounts(home, [api, web], links, "/ws", vol, undefined, "linux")).toEqual([
      { Type: "volume", Source: "gm-workspaces", Target: api.path, VolumeOptions: { Subpath: "github/acme/api" } },
      { Type: "volume", Source: "gm-workspaces", Target: web.path, VolumeOptions: { Subpath: "github/acme/web" } },
    ]);
  });
});

describe("loginEntries", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir: home, cleanup } = await tempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  // Never `home/` itself: its metadata would replace the image's /home owner and mode (F3).
  const homeDirs = [{ path: "home/sandbox/", dir: true, mode: 0o700 }];

  it("copies the provider's existing login files with their folders", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", ".credentials.json"), "{}");
    const entries = await loginEntries(["claude"], home, {});
    expect(entries).toEqual([
      ...homeDirs,
      { path: "home/sandbox/.claude/", dir: true, mode: 0o700 },
      { path: "home/sandbox/.claude/.credentials.json", content: Buffer.from("{}"), mode: 0o600 },
    ]);
  });

  it("copies a login folder recursively", async () => {
    await mkdir(path.join(home, ".config", "opencode", "sub"), { recursive: true });
    await writeFile(path.join(home, ".config", "opencode", "sub", "a.json"), "a");
    const entries = await loginEntries(["opencode"], home, {});
    expect(entries.map((e) => e.path)).toEqual([
      "home/sandbox/",
      "home/sandbox/.config/",
      "home/sandbox/.config/opencode/",
      "home/sandbox/.config/opencode/sub/",
      "home/sandbox/.config/opencode/sub/a.json",
    ]);
  });

  it("fails without a login file or key, and copies only HOME with a key or for fake", async () => {
    await expect(loginEntries(["claude"], home, {})).rejects.toThrow(
      "no claude login to copy into the sandbox: log in once in a terminal, or set ANTHROPIC_API_KEY",
    );
    await expect(loginEntries(["claude"], home, {})).rejects.toMatchObject({ status: 400 });
    expect(await loginEntries(["claude"], home, { ANTHROPIC_API_KEY: "k" })).toEqual(homeDirs);
    expect(await loginEntries(["fake"], home, {})).toEqual(homeDirs);
  });
});

describe("containerBody", () => {
  it("sets the limits, security options, network and command", () => {
    const body = containerBody({
      image: "img",
      hostname: "sbx-1",
      owner: { uid: 1000, gid: 1000 },
      env: ["A=1"],
      args: ["diamond", "--spec", "spec.md", "--provider", "fake"],
      cwd: ws.path,
      runId: "gm-1",
      workspaceId: ws.id,
      limits: { cpus: 2, memoryMb: 4096, pids: 2048 },
      mounts: [],
    }) as { Cmd: string[]; User: string; Labels: Record<string, string>; HostConfig: Record<string, unknown> };
    expect(body.User).toBe("1000:1000");
    expect(body.Labels).toEqual({ "gm.run": "gm-1", "gm.workspace": ws.id });
    expect(body.Cmd).toEqual(["node", "/opt/gm-tools/graph-execution/dist/cli.js", "diamond", "--spec", "spec.md", "--provider", "fake", "--web-serve"]);
    expect(body.HostConfig).toMatchObject({
      Memory: 4096 * 1024 * 1024,
      NanoCpus: 2e9,
      PidsLimit: 2048,
      SecurityOpt: ["no-new-privileges"],
      Init: true,
      AutoRemove: false,
      NetworkMode: "gm-sandbox",
    });
    expect(body.HostConfig.PortBindings).toBeUndefined();
  });

  it("publishes the page's port on the host's loopback when asked", () => {
    const body = containerBody({
      image: "img",
      hostname: "sbx-1",
      owner: { uid: 1000, gid: 1000 },
      env: [],
      args: [],
      cwd: ws.path,
      runId: "gm-1",
      workspaceId: ws.id,
      limits: { cpus: 2, memoryMb: 4096, pids: 2048 },
      mounts: [],
      publishPort: 7600,
    }) as { ExposedPorts?: Record<string, object>; HostConfig: Record<string, unknown> };
    expect(body.ExposedPorts).toEqual({ "7600/tcp": {} });
    expect(body.HostConfig.PortBindings).toEqual({ "7600/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] });
  });
});
