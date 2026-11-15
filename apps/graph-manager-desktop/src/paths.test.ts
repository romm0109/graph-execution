import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPaths } from "./paths.js";

describe("bundledPaths", () => {
  it("uses app.asar.unpacked when packaged", () => {
    const R = path.join("R");
    expect(bundledPaths({ packaged: true, resourcesPath: R })).toEqual({
      serverEntry: path.join(R, "app.asar.unpacked", "node_modules", "graph-manager", "dist", "server", "main.js"),
      graphExecutionCli: path.join(R, "app.asar.unpacked", "node_modules", "graph-execution", "dist", "cli.js"),
    });
  });

  it("resolves the workspace packages in dev", () => {
    const fake = (name: string) => path.join("ws", name, "package.json");
    expect(bundledPaths({ packaged: false, resolvePackageJson: fake })).toEqual({
      serverEntry: path.join("ws", "graph-manager", "dist", "server", "main.js"),
      graphExecutionCli: path.join("ws", "graph-execution", "dist", "cli.js"),
    });
  });

  it("finds the real packages in dev", () => {
    const got = bundledPaths({ packaged: false });
    expect(got.serverEntry.endsWith(path.join("graph-manager", "dist", "server", "main.js"))).toBe(true);
    expect(got.graphExecutionCli.endsWith(path.join("graph-execution", "dist", "cli.js"))).toBe(true);
  });

  it("throws a helpful error when a package can't be found", () => {
    const missing = () => {
      throw new Error("can't find graph-manager; run npm install at the repo root");
    };
    expect(() => bundledPaths({ packaged: false, resolvePackageJson: missing })).toThrow(/run npm install/);
  });
});
