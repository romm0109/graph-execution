import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("throws when GM_PASSWORD is missing or empty", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow("GM_PASSWORD is required");
    expect(() => loadConfig({ GM_PASSWORD: "" })).toThrow("GM_PASSWORD is required");
  });

  it("applies the defaults", () => {
    const c = loadConfig({ GM_PASSWORD: "pw" });
    expect(c.password).toBe("pw");
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

  it("rejects a bad port", () => {
    expect(() => loadConfig({ GM_PASSWORD: "pw", GM_PORT: "abc" })).toThrow(ConfigError);
  });
});
