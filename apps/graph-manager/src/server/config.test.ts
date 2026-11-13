import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, defaultDockerSocket, loadConfig, parseExtensions } from "./config.js";

describe("loadConfig", () => {
  it("does not need GM_PASSWORD", () => {
    const c = loadConfig({});
    expect(c.port).toBe(7420);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toBe(path.join(os.homedir(), ".graph-manager"));
    expect("password" in c).toBe(false);
    expect("password" in loadConfig({ GM_PASSWORD: "pw" })).toBe(false);
  });

  it("applies the defaults", () => {
    const c = loadConfig({ GM_PASSWORD: "pw" });
    expect(c.port).toBe(7420);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toBe(path.join(os.homedir(), ".graph-manager"));
    expect(c.workspacesDir).toBe(path.join(os.homedir(), "graph-manager-workspaces"));
    expect(c.githubApiUrl).toBe("https://api.github.com");
    expect(c.graphExecutionBin).toMatch(/graph-execution[\\/]dist[\\/]cli\.js$/);
  });

  it("reads the overrides", () => {
    const c = loadConfig({
      GM_PASSWORD: "pw",
      GM_PORT: "9000",
      GM_HOST: "0.0.0.0",
      GM_DATA_DIR: "/tmp/d",
      GM_WORKSPACES_DIR: "/tmp/w",
      GM_GITHUB_API_URL: "http://127.0.0.1:1234/",
      GM_GRAPH_EXECUTION_BIN: "/bin/ge",
    });
    expect(c).toMatchObject({ port: 9000, host: "0.0.0.0", dataDir: path.resolve("/tmp/d"), workspacesDir: path.resolve("/tmp/w"), githubApiUrl: "http://127.0.0.1:1234", graphExecutionBin: "/bin/ge" });
  });

  it("reads the sandbox settings", () => {
    const d = loadConfig({ GM_PASSWORD: "pw" });
    expect(d.dockerSocket).toBe(defaultDockerSocket({}));
    expect(d.sandboxImage).toBeUndefined();
    expect(d.sandboxWorkspacesSource).toBeUndefined();
    expect(d.sandboxToolsDir).toBeUndefined();
    const c = loadConfig({
      GM_PASSWORD: "pw",
      GM_DOCKER_SOCKET: "/tmp/d.sock",
      GM_SANDBOX_IMAGE: "img:1",
      GM_SANDBOX_WORKSPACES_SOURCE: "gm-workspaces",
      GM_SANDBOX_TOOLS_DIR: "/tmp/tools",
    });
    expect(c).toMatchObject({ dockerSocket: "/tmp/d.sock", sandboxImage: "img:1", sandboxWorkspacesSource: "gm-workspaces", sandboxToolsDir: path.resolve("/tmp/tools") });
  });

  it("reads the Docker endpoint from DOCKER_HOST, after GM_DOCKER_SOCKET", () => {
    expect(loadConfig({ GM_PASSWORD: "pw", DOCKER_HOST: "unix:///tmp/dh.sock" }).dockerSocket).toBe("/tmp/dh.sock");
    expect(loadConfig({ GM_PASSWORD: "pw", DOCKER_HOST: "tcp://127.0.0.1:1" }).dockerSocket).toBe(defaultDockerSocket({}));
    expect(loadConfig({ GM_PASSWORD: "pw", GM_DOCKER_SOCKET: "/tmp/d.sock", DOCKER_HOST: "unix:///tmp/dh.sock" }).dockerSocket).toBe("/tmp/d.sock");
  });

  it("rejects a bad port", () => {
    expect(() => loadConfig({ GM_PASSWORD: "pw", GM_PORT: "abc" })).toThrow(ConfigError);
  });
});

describe("defaultDockerSocket", () => {
  const HOME = "/Users/me";
  const VAR_RUN = "/var/run/docker.sock";
  const HOME_RUN = "/Users/me/.docker/run/docker.sock";
  const HOME_DESKTOP = "/Users/me/.docker/desktop/docker.sock";
  const ALL = [VAR_RUN, HOME_RUN, HOME_DESKTOP];
  const PIPE = "//./pipe/docker_engine";

  const rows: [string, NodeJS.ProcessEnv, NodeJS.Platform, string[], string][] = [
    ["GM_DOCKER_SOCKET wins over DOCKER_HOST", { GM_DOCKER_SOCKET: "/tmp/d.sock", DOCKER_HOST: "unix:///x.sock" }, "linux", ALL, "/tmp/d.sock"],
    ["GM_DOCKER_SOCKET may be a named pipe", { GM_DOCKER_SOCKET: "//./pipe/custom" }, "win32", [], "//./pipe/custom"],
    ["a blank GM_DOCKER_SOCKET is unset", { GM_DOCKER_SOCKET: "  ", DOCKER_HOST: "unix:///run/user/1000/docker.sock" }, "linux", [], "/run/user/1000/docker.sock"],
    ["an npipe DOCKER_HOST", { DOCKER_HOST: "npipe:////./pipe/docker_engine" }, "win32", [], PIPE],
    ["an npipe DOCKER_HOST of another pipe", { DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine" }, "win32", [], "//./pipe/dockerDesktopLinuxEngine"],
    ["the scheme decides, not the platform", { DOCKER_HOST: "npipe:////./pipe/x" }, "linux", [], "//./pipe/x"],
    ["tcp is ignored on linux", { DOCKER_HOST: "tcp://127.0.0.1:2375" }, "linux", [], VAR_RUN],
    ["tcp is ignored on win32", { DOCKER_HOST: "tcp://127.0.0.1:2375" }, "win32", [], PIPE],
    ["ssh is ignored", { DOCKER_HOST: "ssh://me@host" }, "darwin", [HOME_RUN], HOME_RUN],
    ["an empty unix path is ignored", { DOCKER_HOST: "unix://" }, "linux", [], VAR_RUN],
    ["linux prefers /var/run", {}, "linux", ALL, VAR_RUN],
    ["darwin takes ~/.docker/run first", {}, "darwin", [HOME_RUN, HOME_DESKTOP], HOME_RUN],
    ["darwin takes ~/.docker/desktop last", {}, "darwin", [HOME_DESKTOP], HOME_DESKTOP],
    ["/var/run when nothing exists", {}, "darwin", [], VAR_RUN],
  ];

  it.each(rows)("%s", (_name, env, platform, list, result) => {
    expect(defaultDockerSocket(env, platform, (f) => list.includes(f), HOME)).toBe(result);
  });

  it("does not look at the file system on win32", () => {
    const exists = (): boolean => {
      throw new Error("exists was called");
    };
    expect(defaultDockerSocket({}, "win32", exists, HOME)).toBe(PIPE);
  });
});

describe("GM_EXTENSIONS", () => {
  it("parses the extensions and the secret", () => {
    const c = loadConfig({ GM_EXTENSIONS: "jira=http://jira:8080, other=https://h:9000/base/", GM_EXTENSION_SECRET: "s" });
    expect(c.extensions).toEqual([
      { name: "jira", url: "http://jira:8080" },
      { name: "other", url: "https://h:9000/base" },
    ]);
    expect(c.extensionSecret).toBe("s");
  });

  it("leaves both fields unset without GM_EXTENSIONS", () => {
    const c = loadConfig({ GM_EXTENSION_SECRET: "s" });
    expect(c.extensions).toBeUndefined();
    expect(c.extensionSecret).toBeUndefined();
  });

  it("skips empty items", () => {
    expect(parseExtensions("a=http://x,")).toEqual([{ name: "a", url: "http://x" }]);
  });

  it.each([
    "Jira=http://jira",
    "1x=http://jira",
    `${"a".repeat(33)}=http://jira`,
    "jira",
    "jira=ftp://x",
    "jira=not a url",
    "jira=http://u:p@x",
    "jira=http://x?q=1",
    "jira=http://a,jira=http://b",
  ])("rejects %s", (value) => {
    expect(() => loadConfig({ GM_EXTENSIONS: value, GM_EXTENSION_SECRET: "s" })).toThrow(ConfigError);
    expect(() => loadConfig({ GM_EXTENSIONS: value, GM_EXTENSION_SECRET: "s" })).toThrow(/GM_EXTENSIONS/);
  });

  it("needs GM_EXTENSION_SECRET", () => {
    expect(() => loadConfig({ GM_EXTENSIONS: "jira=http://jira:8080" })).toThrow(ConfigError);
    expect(() => loadConfig({ GM_EXTENSIONS: "jira=http://jira:8080" })).toThrow(/GM_EXTENSION_SECRET/);
  });
});
