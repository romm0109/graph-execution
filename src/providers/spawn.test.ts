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

  it("writes `input` to stdin, however long, and closes it", async () => {
    // Far past cmd.exe's 8191-character command line, with characters a shell would treat specially.
    const input = `${"x".repeat(100_000)}\n%PATH% ^ & | < > "quoted" $HOME \`tick\``;
    const agent = spawnAgent(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(0, 'utf8'))"], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      input,
    });
    expect(await agent.exitCode).toBe(0);
    expect((await agent.child).stdout).toBe(input);
  });

  it("gives an agent without input an empty, closed stdin", async () => {
    const agent = spawnAgent(process.execPath, ["-e", "process.stdout.write(String(require('fs').readFileSync(0).length))"], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    expect(await agent.exitCode).toBe(0);
    expect((await agent.child).stdout).toBe("0");
  });
});
