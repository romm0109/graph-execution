import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_ARGS_ENV, codexProvider, parseCodexLine } from "./codex.js";
import { getProvider } from "./index.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

/**
 * Fake `codex`: records `{argv, cwd, stdin}` to $FAKE_CODEX_RECORD, prints two stream-json lines and exits with
 * $FAKE_CODEX_EXIT. With $FAKE_CODEX_HANG it writes its pid to $FAKE_CODEX_RECORD.pid and never exits.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, "utf8") }));
console.log(JSON.stringify({ type: "thread.started" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.error("warning: plain text");
if (process.env.FAKE_CODEX_HANG) {
  fs.writeFileSync(process.env.FAKE_CODEX_RECORD + ".pid", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
}
`;

const ENV_KEYS = ["PATH", "FAKE_CODEX_RECORD", "FAKE_CODEX_EXIT", "FAKE_CODEX_HANG", CODEX_ARGS_ENV] as const;
let saved: Record<string, string | undefined>;
let binDir: string;
let worktree: string;
let record: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  binDir = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "graph-execution-wt-")));
  record = path.join(binDir, "record.json");
  const bin = path.join(binDir, "codex");
  await writeFile(bin, FAKE_CODEX);
  await chmod(bin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_CODEX_RECORD = record;
  delete process.env.FAKE_CODEX_EXIT;
  delete process.env.FAKE_CODEX_HANG;
  delete process.env[CODEX_ARGS_ENV];
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

describe("codex provider", () => {
  it("runs codex exec unattended in the worktree and streams its output", async () => {
    const run = codexProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 0 });
    expect(events).toEqual([
      {
        type: "output",
        text: `${JSON.stringify({ type: "thread.started" })}\n`,
      },
      { type: "output", text: "hello\n" },
      { type: "output", text: "warning: plain text\n" },
      { type: "exit", code: 0 },
    ]);
    expect(await recorded()).toEqual({
      argv: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json", "-"],
      cwd: worktree,
      stdin: "do it; rm -rf / # not a shell",
    });
  });

  it("passes --model and appends extra args from the env", async () => {
    process.env[CODEX_ARGS_ENV] = " --profile  work ";
    const run = codexProvider.run(opts({ model: "o3", prompt: "--help" }));
    await run.done;
    expect((await recorded()).argv.slice(3)).toEqual(["--model", "o3", "--profile", "work", "-"]);
    expect((await recorded()).stdin).toBe("--help");
  });

  it("surfaces a non-zero exit code", async () => {
    process.env.FAKE_CODEX_EXIT = "3";
    const run = codexProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 3 });
    expect(events.at(-1)).toEqual({ type: "exit", code: 3 });
  });

  it("kills the child when the signal aborts", async () => {
    process.env.FAKE_CODEX_HANG = "1";
    const controller = new AbortController();
    const run = codexProvider.run(opts({ signal: controller.signal }));
    const pid = Number(await waitFor(`${record}.pid`));
    controller.abort();
    expect((await run.done).exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects done with a clear message when codex cannot be started", async () => {
    process.env.PATH = worktree;
    const run = codexProvider.run(opts());
    await expect(run.done).rejects.toThrow(/failed to start "codex".*ENOENT/);
    await expect(collect(run.events)).rejects.toThrow(/ENOENT/);
  });
});

describe("parseCodexLine", () => {
  it("falls back to the raw line for other events and non-JSON lines", () => {
    expect(parseCodexLine("not json")).toBe("not json\n");
    const toolCall = '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}';
    expect(parseCodexLine(toolCall)).toBe(`${toolCall}\n`);
  });
});

describe("getProvider", () => {
  it("returns the codex provider when codex is on the PATH", async () => {
    expect((await getProvider("codex", worktree)).name).toBe("codex");
  });

  it("fails fast when codex is not on the PATH", async () => {
    process.env.PATH = [worktree, "/usr/bin", "/bin"].join(path.delimiter);
    await expect(getProvider("codex", worktree)).rejects.toThrow(/"codex" CLI was not found on the PATH/);
  });
});
