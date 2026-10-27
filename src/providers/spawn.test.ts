import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_ID_ENV, RUNS_ROOT_ENV } from "../state/paths.js";
import { spawnAgent, type SpawnedAgent } from "./spawn.js";

/** True once `pid` has exited: no such process, or a zombie its new parent has not reaped yet. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false;
  } catch {
    return false;
  }
}

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

  it.skipIf(process.platform === "win32")(
    "kills what the agent left running once it exits, with SIGKILL when it ignores SIGTERM",
    async () => {
      // The agent starts a child that ignores SIGTERM, prints its PID and exits without waiting for it.
      const leftover = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const script = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leftover)}], { stdio: 'ignore' });
        setTimeout(() => { console.log(c.pid); process.exit(0); }, 300);`;
      const agent = spawnAgent(process.execPath, ["-e", script], { cwd: process.cwd(), signal: new AbortController().signal });
      const pid = Number((await readStdout(agent)).trim());
      expect(pid).toBeGreaterThan(0);
      expect(await agent.exitCode).toBe(0);
      await expect.poll(() => gone(pid), { timeout: 2000 }).toBe(true);
    },
    15_000,
  );
});
