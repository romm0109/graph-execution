import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnAgent } from "./spawn.js";

describe("spawnAgent", () => {
  it("sets PWD to the agent's cwd, not the parent's, for CLIs that read PWD (opencode)", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ge-spawn-")));
    try {
      const agent = spawnAgent(process.execPath, ["-e", "console.log(process.env.PWD)"], {
        cwd: dir,
        signal: new AbortController().signal,
      });
      expect(await agent.exitCode).toBe(0);
      expect((await agent.child).stdout.trim()).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
