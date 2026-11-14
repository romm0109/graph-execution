import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, defaultDockerSocket, loadConfig } from "./config.js";

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

  it("reads GM_BLOB_URL", () => {
    expect(loadConfig({ GM_BLOB_URL: "s3://b/p" }).blobUrl).toBe("s3://b/p");
    expect(loadConfig({ GM_BLOB_URL: "" }).blobUrl).toBeUndefined();
    expect(loadConfig({}).blobUrl).toBeUndefined();
    expect(() => loadConfig({ GM_BLOB_URL: "http://x" })).toThrow(new ConfigError("invalid GM_BLOB_URL: must start with s3://"));
  });

  it("reads GM_MAX_RUN_CONTAINERS", () => {
    expect(loadConfig({ GM_MAX_RUN_CONTAINERS: "3" }).maxRunContainers).toBe(3);
    expect(loadConfig({}).maxRunContainers).toBeUndefined();
    expect(() => loadConfig({ GM_MAX_RUN_CONTAINERS: "0" })).toThrow(/invalid GM_MAX_RUN_CONTAINERS/);
    expect(() => loadConfig({ GM_MAX_RUN_CONTAINERS: "x" })).toThrow(/invalid GM_MAX_RUN_CONTAINERS/);
  });

  it("reads GM_MAX_SESSIONS", () => {
    expect(loadConfig({ GM_MAX_SESSIONS: "3" }).maxSessions).toBe(3);
    expect(loadConfig({}).maxSessions).toBeUndefined();
    expect("maxSessions" in loadConfig({})).toBe(false);
    expect(() => loadConfig({ GM_MAX_SESSIONS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ GM_MAX_SESSIONS: "x" })).toThrow(ConfigError);
  });

  it("reads GM_SESSION_IDLE_MINUTES", () => {
    expect(loadConfig({ GM_SESSION_IDLE_MINUTES: "15" }).sessionIdleMinutes).toBe(15);
    expect(loadConfig({}).sessionIdleMinutes).toBeUndefined();
    expect(loadConfig({ GM_SESSION_IDLE_MINUTES: "" }).sessionIdleMinutes).toBeUndefined();
    expect(() => loadConfig({ GM_SESSION_IDLE_MINUTES: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ GM_SESSION_IDLE_MINUTES: "1.5" })).toThrow(ConfigError);
  });

  it("reads GM_SESSION_RUNTIME: auto by default", () => {
    expect(loadConfig({}).sessionRuntime).toBe("auto");
    expect(loadConfig({ GM_SESSION_RUNTIME: "" }).sessionRuntime).toBe("auto");
    expect(loadConfig({ GM_SESSION_RUNTIME: "docker" }).sessionRuntime).toBe("docker");
    expect(loadConfig({ GM_SESSION_RUNTIME: "local" }).sessionRuntime).toBe("local");
    expect(() => loadConfig({ GM_SESSION_RUNTIME: "k8s" })).toThrow(new ConfigError('GM_SESSION_RUNTIME must be "auto", "local" or "docker"'));
  });

  it("reads GM_DATABASE_URL", () => {
    expect(loadConfig({ GM_DATABASE_URL: "postgres://u:p@db:5432/gm" }).databaseUrl).toBe("postgres://u:p@db:5432/gm");
    expect(loadConfig({ GM_DATABASE_URL: "postgresql://db/gm" }).databaseUrl).toBe("postgresql://db/gm");
    expect(loadConfig({ GM_DATABASE_URL: "" }).databaseUrl).toBeUndefined();
    expect(loadConfig({}).databaseUrl).toBeUndefined();
    expect(() => loadConfig({ GM_DATABASE_URL: "mysql://x" })).toThrow(
      new ConfigError("invalid GM_DATABASE_URL: must start with postgres:// or postgresql://"),
    );
  });
});

describe("loadConfig: accounts", () => {
  it("reads GM_AUTH: users by default, password as an alias", () => {
    expect(loadConfig({}).auth).toBe("users");
    expect(loadConfig({ GM_AUTH: "users" }).auth).toBe("users");
    expect(loadConfig({ GM_AUTH: "password" }).auth).toBe("users");
    expect(() => loadConfig({ GM_AUTH: "nope" })).toThrow(new ConfigError('GM_AUTH must be "users" or "gateway"'));
  });

  it("reads GM_SIGNUP: closed by default", () => {
    expect(loadConfig({}).signup).toBe("closed");
    expect(loadConfig({ GM_SIGNUP: "closed" }).signup).toBe("closed");
    expect(loadConfig({ GM_SIGNUP: "open" }).signup).toBe("open");
    expect(() => loadConfig({ GM_SIGNUP: "yes" })).toThrow(new ConfigError('GM_SIGNUP must be "open" or "closed"'));
  });

  it("does not set passwordSource", () => {
    expect(loadConfig({}).passwordSource).toBeUndefined();
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

describe("loadConfig: gateway", () => {
  const SECRET = "s".repeat(32);

  it("reads GM_AUTH=gateway with GM_GATEWAY_SECRET", () => {
    const c = loadConfig({ GM_AUTH: "gateway", GM_GATEWAY_SECRET: SECRET });
    expect(c.auth).toBe("gateway");
    expect(c.gatewaySecret).toBe(SECRET);
  });

  it("requires a secret of at least 32 characters", () => {
    expect(() => loadConfig({ GM_AUTH: "gateway" })).toThrow(new ConfigError("GM_GATEWAY_SECRET is required when GM_AUTH=gateway"));
    expect(() => loadConfig({ GM_AUTH: "gateway", GM_GATEWAY_SECRET: "s".repeat(31) })).toThrow(
      new ConfigError("GM_GATEWAY_SECRET must be at least 32 characters"),
    );
  });

  it("checks GM_GATEWAY_LOGOUT_URL", () => {
    const message = new ConfigError("GM_GATEWAY_LOGOUT_URL must be an absolute http(s) URL");
    expect(() => loadConfig({ GM_GATEWAY_LOGOUT_URL: "ftp://x" })).toThrow(message);
    expect(() => loadConfig({ GM_AUTH: "gateway", GM_GATEWAY_SECRET: SECRET, GM_GATEWAY_LOGOUT_URL: "/logout" })).toThrow(message);
    const c = loadConfig({ GM_AUTH: "gateway", GM_GATEWAY_SECRET: SECRET, GM_GATEWAY_LOGOUT_URL: "https://gw.example.com/logout" });
    expect(c.gatewayLogoutUrl).toBe("https://gw.example.com/logout");
  });
});

describe("loadConfig: GM_UI_PLUGINS", () => {
  it("reads a comma-separated list of https:// URLs and /-paths", () => {
    expect(loadConfig({ GM_UI_PLUGINS: "/plugins/a.js, https://x.example.com/b.js" }).uiPlugins).toEqual(["/plugins/a.js", "https://x.example.com/b.js"]);
    expect(loadConfig({ GM_UI_PLUGINS: " , /a.js ," }).uiPlugins).toEqual(["/a.js"]);
  });

  it("leaves uiPlugins unset when GM_UI_PLUGINS is unset or blank", () => {
    expect(loadConfig({}).uiPlugins).toBeUndefined();
    expect(loadConfig({ GM_UI_PLUGINS: "  " }).uiPlugins).toBeUndefined();
    expect(loadConfig({ GM_UI_PLUGINS: " , " }).uiPlugins).toBeUndefined();
  });

  it("rejects other entries", () => {
    for (const entry of ["http://x/a.js", "plugins/a.js", "//evil/a.js"]) {
      expect(() => loadConfig({ GM_UI_PLUGINS: `/ok.js,${entry}` })).toThrow(
        new ConfigError(`GM_UI_PLUGINS entries must be https:// URLs or paths starting with /: ${entry}`),
      );
    }
  });
});
