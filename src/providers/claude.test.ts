import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_ARGS_ENV, claudeProvider, parseClaudeLine } from "./claude.js";
import { getProvider } from "./index.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

/**
 * Fake `claude`: records `{argv, cwd, stdin}` to $FAKE_CLAUDE_RECORD, prints two stream-json lines and exits with
 * $FAKE_CLAUDE_EXIT. With $FAKE_CLAUDE_HANG it writes its pid to $FAKE_CLAUDE_RECORD.pid and never exits.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, "utf8") }));
console.log(JSON.stringify({ type: "system", subtype: "init" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Bash" }] } }));
if (process.env.FAKE_CLAUDE_HANG) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD + ".pid", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
}
`;

const ENV_KEYS = ["PATH", "FAKE_CLAUDE_RECORD", "FAKE_CLAUDE_EXIT", "FAKE_CLAUDE_HANG", CLAUDE_ARGS_ENV] as const;
let saved: Record<string, string | undefined>;
let binDir: string;
let worktree: string;
let record: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  binDir = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "graph-execution-wt-")));
  record = path.join(binDir, "record.json");
  const bin = path.join(binDir, "claude");
  await writeFile(bin, FAKE_CLAUDE);
  await chmod(bin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_CLAUDE_RECORD = record;
  delete process.env.FAKE_CLAUDE_EXIT;
  delete process.env.FAKE_CLAUDE_HANG;
  delete process.env[CLAUDE_ARGS_ENV];
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const opts = (overrides: Partial<AgentRunOptions> = {}): AgentRunOptions => ({
  role: "task",
  prompt: "do it; rm -rf / # not a shell",
  cwd: worktree,
  signal: new AbortController().signal,
  label: "1",
  ...overrides,
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const recorded = async (): Promise<{ argv: string[]; cwd: string; stdin: string }> => JSON.parse(await readFile(record, "utf8"));

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
  return readFile(file, "utf8");
}

describe("claude provider", () => {
  it("runs claude headless in full-auto mode in the worktree and streams its output", async () => {
    const run = claudeProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 0 });
    expect(events).toEqual([
      { type: "output", text: `${JSON.stringify({ type: "system", subtype: "init" })}\n` },
      { type: "output", text: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    expect(await recorded()).toEqual({
      argv: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
      cwd: worktree,
      stdin: "do it; rm -rf / # not a shell",
    });
  });

  it("passes --model and appends extra args from the env", async () => {
    process.env[CLAUDE_ARGS_ENV] = " --max-turns  5 ";
    const run = claudeProvider.run(opts({ model: "opus" }));
    await run.done;
    expect((await recorded()).argv.slice(-4)).toEqual(["--model", "opus", "--max-turns", "5"]);
  });

  it("surfaces a non-zero exit code", async () => {
    process.env.FAKE_CLAUDE_EXIT = "3";
    const run = claudeProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 3 });
    expect(events.at(-1)).toEqual({ type: "exit", code: 3 });
  });

  it("kills the child when the signal aborts", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    const controller = new AbortController();
    const run = claudeProvider.run(opts({ signal: controller.signal }));
    const pid = Number(await waitFor(`${record}.pid`));
    controller.abort();
    expect((await run.done).exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects done with a clear message when claude cannot be started", async () => {
    process.env.PATH = worktree;
    const run = claudeProvider.run(opts());
    await expect(run.done).rejects.toThrow(/failed to start "claude".*ENOENT/);
    await expect(collect(run.events)).rejects.toThrow(/ENOENT/);
  });
});

describe("parseClaudeLine", () => {
  it("falls back to the raw line for non-assistant and non-JSON lines", () => {
    expect(parseClaudeLine("not json")).toBe("not json\n");
    expect(parseClaudeLine('{"type":"assistant","message":{"content":[]}}')).toBe(
      '{"type":"assistant","message":{"content":[]}}\n',
    );
  });
});

describe("getProvider", () => {
  it("returns the claude provider when claude is on the PATH", async () => {
    expect((await getProvider("claude", worktree)).name).toBe("claude");
  });

  it("fails fast when claude is not on the PATH", async () => {
    process.env.PATH = [worktree, "/usr/bin", "/bin"].join(path.delimiter);
    await expect(getProvider("claude", worktree)).rejects.toThrow(/"claude" CLI was not found on the PATH/);
  });

  it("rejects providers that are not implemented yet", async () => {
    await expect(getProvider("nope")).rejects.toThrow(/not implemented yet/);
  });
});
