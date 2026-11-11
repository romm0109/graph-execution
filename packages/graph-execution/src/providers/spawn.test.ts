import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_ID_ENV, RUNS_ROOT_ENV } from "../state/paths.js";
import { capLines, MAX_LINE_CHARS, spawnAgent, type SpawnedAgent } from "./spawn.js";

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

  it("does not pass on the live run's variables, so a project's tests cannot act on the run", async () => {
    const names = [RUNS_ROOT_ENV, RUN_ID_ENV, "GRAPH_EXECUTION_READY_FILE", "GRAPH_EXECUTION_TASK_NAME"];
    const saved = names.map((n) => process.env[n]);
    for (const n of names) process.env[n] = "live";
    process.env.GRAPH_EXECUTION_FAKE_SCRIPT = "kept";
    try {
      const agent = spawnAgent(process.execPath, ["-e", `console.log(JSON.stringify(${JSON.stringify([...names, "GRAPH_EXECUTION_FAKE_SCRIPT"])}.map((n) => process.env[n] ?? null)))`], {
        cwd: process.cwd(),
        signal: new AbortController().signal,
      });
      expect(JSON.parse(await readStdout(agent))).toEqual([null, null, null, null, "kept"]);
    } finally {
      names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
      delete process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
    }
  });

  it("adds `env` to the agent's environment, on top of ours", async () => {
    process.env.GE_SPAWN_TEST_KEPT = "kept";
    try {
      const agent = spawnAgent(
        process.execPath,
        ["-e", "console.log(JSON.stringify([process.env.COPILOT_AUTO_UPDATE, process.env.GE_SPAWN_TEST_KEPT, process.env.PWD]))"],
        { cwd: process.cwd(), signal: new AbortController().signal, env: { COPILOT_AUTO_UPDATE: "false", PWD: "/ignored" } },
      );
      expect(JSON.parse(await readStdout(agent))).toEqual(["false", "kept", process.cwd()]);
      expect(await agent.exitCode).toBe(0);
    } finally {
      delete process.env.GE_SPAWN_TEST_KEPT;
    }
  });

  it("truncates a line longer than MAX_LINE_CHARS, so output without newlines cannot fill the heap", async () => {
    const agent = spawnAgent(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(8 * 1024 * 1024)); process.stdout.write('\\nend\\n')"],
      { cwd: process.cwd(), signal: new AbortController().signal },
    );
    const lines: string[] = [];
    for await (const line of agent.child.iterable({ from: "all" })) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(lines[0] === "x".repeat(MAX_LINE_CHARS) + " [truncated 7340032 characters]").toBe(true);
    expect(lines[1]).toBe("end");
    expect(await agent.exitCode).toBe(0);
  });

  it("leaves normal output unchanged", async () => {
    const agent = spawnAgent(process.execPath, ["-e", "process.stdout.write('a\\r\\nb\\n')"], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    const lines: string[] = [];
    for await (const line of agent.child.iterable({ from: "all" })) lines.push(line);
    expect(lines).toEqual(["a", "b"]);
  });
});

describe("capLines", () => {
  it("splits lines, truncates long ones and flushes the last partial line", () => {
    const t = capLines(5);
    expect([...t.transform(Buffer.from("abcdefgh\nxy"))]).toEqual(["abcde [truncated 3 characters]\n"]);
    expect([...t.final()]).toEqual(["xy\n"]);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const t = capLines();
    const e = Buffer.from("é");
    expect([...t.transform(e.subarray(0, 1)), ...t.transform(e.subarray(1)), ...t.final()]).toEqual(["é\n"]);
  });
});
