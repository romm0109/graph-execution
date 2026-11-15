import { describe, expect, it } from "vitest";
import { nodeCommand } from "./node.js";

describe("nodeCommand", () => {
  it("adds ELECTRON_RUN_AS_NODE under Electron", () => {
    const versions = { ...process.versions, electron: "39.0.0" } as NodeJS.ProcessVersions;
    expect(nodeCommand(versions, "/A/app")).toEqual({ file: "/A/app", env: { ELECTRON_RUN_AS_NODE: "1" } });
  });

  it("adds nothing under plain Node", () => {
    const plain: Record<string, string | undefined> = { ...process.versions };
    delete plain.electron;
    expect(nodeCommand(plain as unknown as NodeJS.ProcessVersions, "/usr/bin/node")).toEqual({ file: "/usr/bin/node", env: {} });
  });

  it("defaults to this process", () => {
    expect(nodeCommand()).toEqual({ file: process.execPath, env: {} });
  });
});
