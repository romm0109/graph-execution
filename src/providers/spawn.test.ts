import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnAgent, type SpawnedAgent } from "./spawn.js";

/** The agent's stdout, read the way providers read it: line by line. */
async function readStdout(agent: SpawnedAgent): Promise<string> {
  const lines: string[] = [];
  for await (const line of agent.child.iterable()) lines.push(line);
  return lines.join("\n");
}

describe("spawnAgent", () => {
  it("sets PWD to the agent's cwd, not the parent's, for CLIs that read PWD (opencode)", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ge-spawn-")));
    try {
      const agent = spawnAgent(process.execPath, ["-e", "console.log(process.env.PWD)"], {
        cwd: dir,
        signal: new AbortController().signal,
      });
      expect((await readStdout(agent)).trim()).toBe(dir);
      expect(await agent.exitCode).toBe(0);
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
    expect(await readStdout(agent)).toBe(input);
    expect(await agent.exitCode).toBe(0);
  });

  it("gives an agent without input an empty, closed stdin", async () => {
    const agent = spawnAgent(process.execPath, ["-e", "process.stdout.write(String(require('fs').readFileSync(0).length))"], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    expect(await readStdout(agent)).toBe("0");
    expect(await agent.exitCode).toBe(0);
  });

  it("does not keep the agent's output in memory: it is streamed, and long runs print a lot", async () => {
    const agent = spawnAgent(process.execPath, ["-e", "console.log('a'); console.error('b')"], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    const lines: string[] = [];
    for await (const line of agent.child.iterable({ from: "all" })) lines.push(line);
    expect(lines.sort()).toEqual(["a", "b"]);
    const result = await agent.child;
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
    expect(result.all).toBeUndefined();
  });
});
