import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QWEN_ARGS_ENV, parseQwenLine, qwenProvider } from "./qwen.js";
import { getProvider } from "./index.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

/**
 * Fake `qwen`: records `{argv, cwd, stdin}` to $FAKE_QWEN_RECORD, prints stream-json lines and exits with
 * $FAKE_QWEN_EXIT. With $FAKE_QWEN_HANG it writes its pid to $FAKE_QWEN_RECORD.pid and never exits.
 */
const FAKE_QWEN = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_QWEN_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, "utf8") }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }));
console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }));
console.error("warning: plain text");
if (process.env.FAKE_QWEN_HANG) {
  fs.writeFileSync(process.env.FAKE_QWEN_RECORD + ".pid", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(Number(process.env.FAKE_QWEN_EXIT ?? 0));
}
`;

const ENV_KEYS = ["PATH", "FAKE_QWEN_RECORD", "FAKE_QWEN_EXIT", "FAKE_QWEN_HANG", QWEN_ARGS_ENV] as const;
let saved: Record<string, string | undefined>;
let binDir: string;
let worktree: string;
let record: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  binDir = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "graph-execution-wt-")));
  record = path.join(binDir, "record.json");
  const bin = path.join(binDir, "qwen");
  await writeFile(bin, FAKE_QWEN);
  await chmod(bin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_QWEN_RECORD = record;
  delete process.env.FAKE_QWEN_EXIT;
  delete process.env.FAKE_QWEN_HANG;
  delete process.env[QWEN_ARGS_ENV];
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

describe("qwen provider", () => {
  it("runs qwen unattended in the worktree and streams its output", async () => {
    const run = qwenProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 0 });
    expect(events).toEqual([
      {
        type: "output",
        text: `${JSON.stringify({ type: "system", subtype: "init", session_id: "s" })}\n`,
      },
      { type: "output", text: "hello\n" },
      { type: "output", text: "warning: plain text\n" },
      { type: "exit", code: 0 },
    ]);
    expect(await recorded()).toEqual({
      argv: ["--yolo", "--output-format", "stream-json"],
      cwd: worktree,
      stdin: "do it; rm -rf / # not a shell",
    });
  });

  it("passes --model and appends extra args from the env", async () => {
    process.env[QWEN_ARGS_ENV] = " --max-session-turns  200 ";
    const run = qwenProvider.run(opts({ model: "qwen3-coder-plus", prompt: "--help" }));
    await run.done;
    expect((await recorded()).argv.slice(3)).toEqual(["--model", "qwen3-coder-plus", "--max-session-turns", "200"]);
    expect((await recorded()).stdin).toBe("--help");
  });

  it("surfaces a non-zero exit code", async () => {
    process.env.FAKE_QWEN_EXIT = "53";
    const run = qwenProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 53 });
    expect(events.at(-1)).toEqual({ type: "exit", code: 53 });
  });

  it("kills the child when the signal aborts", async () => {
    process.env.FAKE_QWEN_HANG = "1";
    const controller = new AbortController();
    const run = qwenProvider.run(opts({ signal: controller.signal }));
    const pid = Number(await waitFor(`${record}.pid`));
    controller.abort();
    expect((await run.done).exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects done with a clear message when qwen cannot be started", async () => {
    process.env.PATH = worktree;
    const run = qwenProvider.run(opts());
    await expect(run.done).rejects.toThrow(/failed to start "qwen".*ENOENT/);
    await expect(collect(run.events)).rejects.toThrow(/ENOENT/);
  });
});

describe("parseQwenLine", () => {
  it("joins the text blocks of an assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "a" }, { type: "tool_use", name: "x" }, { type: "text", text: "b" }] },
    });
    expect(parseQwenLine(line)).toBe("ab\n");
  });

  it("falls back to the raw line for other events and non-JSON lines", () => {
    const noText = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "x" }] } });
    expect(parseQwenLine(noText)).toBe(`${noText}\n`);
    const result = '{"type":"result","subtype":"success","result":"pong"}';
    expect(parseQwenLine(result)).toBe(`${result}\n`);
    expect(parseQwenLine("not json")).toBe("not json\n");
  });
});

describe("getProvider", () => {
  it("returns the qwen provider when qwen is on the PATH", async () => {
    expect((await getProvider("qwen", worktree)).name).toBe("qwen");
  });

  it("fails fast when qwen is not on the PATH", async () => {
    process.env.PATH = [worktree, "/usr/bin", "/bin"].join(path.delimiter);
    await expect(getProvider("qwen", worktree)).rejects.toThrow(/"qwen" CLI was not found on the PATH/);
  });
});
