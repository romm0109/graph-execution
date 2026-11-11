import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PI_ARGS_ENV, piArgs, piProvider } from "./pi.js";
import { parsePiLine, piFailure } from "./pi-json.js";
import { writeFakeBin } from "../__fixtures__/fake-bin.js";
import { getProvider } from "./index.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

/**
 * Fake `pi`: records `{argv, cwd, stdin}` to $FAKE_PI_RECORD, prints `--mode json` events and exits with
 * $FAKE_PI_EXIT. With $FAKE_PI_FAIL the last assistant message fails (stopReason error) and it still exits 0, as pi
 * does. With $FAKE_PI_HANG it writes its pid to $FAKE_PI_RECORD.pid and never exits.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, "utf8") }));
const out = (e) => console.log(JSON.stringify(e));
out({ type: "session", version: 3, id: "s", cwd: process.cwd() });
out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } });
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } }], stopReason: "toolUse" } });
out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } });
out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi\\n" }] }, isError: false });
if (process.env.FAKE_PI_FAIL) out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } });
else out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
console.error("warning: plain text");
if (process.env.FAKE_PI_HANG) {
  fs.writeFileSync(process.env.FAKE_PI_RECORD + ".pid", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(Number(process.env.FAKE_PI_EXIT ?? 0));
}
`;

const ENV_KEYS = ["PATH", "FAKE_PI_RECORD", "FAKE_PI_EXIT", "FAKE_PI_HANG", "FAKE_PI_FAIL", PI_ARGS_ENV] as const;
let saved: Record<string, string | undefined>;
let binDir: string;
let worktree: string;
let record: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  binDir = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "graph-execution-wt-")));
  record = path.join(binDir, "record.json");
  await writeFakeBin(path.join(binDir, "pi"), FAKE_PI);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_PI_RECORD = record;
  delete process.env.FAKE_PI_EXIT;
  delete process.env.FAKE_PI_HANG;
  delete process.env.FAKE_PI_FAIL;
  delete process.env[PI_ARGS_ENV];
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

const STDERR_LINE = { type: "output", text: "warning: plain text\n" };
const withoutStderr = (events: AgentEvent[]): AgentEvent[] =>
  events.filter((e) => !(e.type === "output" && e.text === STDERR_LINE.text));

describe("pi provider", () => {
  it("runs pi unattended in the worktree, prompt on stdin, and streams its text and tool calls", async () => {
    const run = piProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 0 });
    // stdout and stderr are two pipes: their lines arrive in no fixed order relative to each other.
    expect(events).toContainEqual(STDERR_LINE);
    expect(withoutStderr(events)).toEqual([
      { type: "output", text: "hello\n" },
      { type: "tool", name: "bash", input: { command: "echo hi" } },
      { type: "output", text: "done\n" },
      { type: "exit", code: 0 },
    ]);
    expect(await recorded()).toEqual({
      argv: ["--mode", "json", "--no-session"],
      cwd: worktree,
      stdin: "do it; rm -rf / # not a shell",
    });
  });

  it("passes --model and appends extra args from the env", async () => {
    process.env[PI_ARGS_ENV] = " --thinking  high ";
    const run = piProvider.run(opts({ model: "anthropic/claude-sonnet-4", prompt: "--help" }));
    await run.done;
    expect((await recorded()).argv).toEqual(["--mode", "json", "--no-session", "--model", "anthropic/claude-sonnet-4", "--thinking", "high"]);
    expect((await recorded()).stdin).toBe("--help");
  });

  it("keeps quoted extra args from the env together", async () => {
    process.env[PI_ARGS_ENV] = `--append-system-prompt "two words" --x 'a b' c\\ d`;
    const run = piProvider.run(opts());
    await run.done;
    expect((await recorded()).argv.slice(-5)).toEqual(["--append-system-prompt", "two words", "--x", "a b", "c d"]);
  });

  it("surfaces a non-zero exit code", async () => {
    process.env.FAKE_PI_EXIT = "53";
    const run = piProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 53 });
    expect(events.at(-1)).toEqual({ type: "exit", code: 53 });
  });

  it("fails the attempt when the last assistant message failed although pi exited 0", async () => {
    process.env.FAKE_PI_FAIL = "1";
    const run = piProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 1 });
    expect(events).toContainEqual({ type: "output", text: "pi: boom\n" });
    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
  });

  it("resolves done even when nobody reads the events", async () => {
    process.env.FAKE_PI_FAIL = "1";
    expect(await piProvider.run(opts()).done).toEqual({ exitCode: 1 });
  });

  it("kills the child when the signal aborts", async () => {
    process.env.FAKE_PI_HANG = "1";
    const controller = new AbortController();
    const run = piProvider.run(opts({ signal: controller.signal }));
    const pid = Number(await waitFor(`${record}.pid`));
    controller.abort();
    expect((await run.done).exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects done with a clear message when pi cannot be started", async () => {
    process.env.PATH = worktree;
    const run = piProvider.run(opts());
    await expect(run.done).rejects.toThrow(/failed to start "pi".*ENOENT/);
    await expect(collect(run.events)).rejects.toThrow(/ENOENT/);
  });
});

describe("piArgs", () => {
  it("throws on a malformed args env", () => {
    expect(() => piArgs({}, { [PI_ARGS_ENV]: `--x "open` })).toThrow(PI_ARGS_ENV);
  });
});

describe("parsePiLine", () => {
  const end = (message: object): string => JSON.stringify({ type: "message_end", message });

  it("joins the text items of an assistant message_end", () => {
    const line = end({
      role: "assistant",
      content: [{ type: "text", text: "a" }, { type: "toolCall", name: "x" }, { type: "thinking", thinking: "t" }, { type: "text", text: "b" }],
    });
    expect(parsePiLine(line)).toBe("ab\n");
  });

  it("gives an empty string for an assistant message without text and for other JSON events", () => {
    expect(parsePiLine(end({ role: "assistant", content: [{ type: "toolCall", name: "x" }], stopReason: "toolUse" }))).toBe("");
    expect(parsePiLine(end({ role: "toolResult", content: [{ type: "text", text: "hi" }] }))).toBe("");
    for (const type of ["session", "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "something_new"]) {
      expect(parsePiLine(JSON.stringify({ type, delta: "x" })), type).toBe("");
    }
  });

  it("passes lines that are not JSON objects through", () => {
    expect(parsePiLine("not json")).toBe("not json\n");
    expect(parsePiLine("42")).toBe("42\n");
  });
});

describe("piFailure", () => {
  const end = (message: object): string => JSON.stringify({ type: "message_end", message });

  it("gives the errorMessage of a failed or aborted assistant message", () => {
    expect(piFailure(end({ role: "assistant", content: [], stopReason: "error", errorMessage: "500 Internal Server Error" }))).toBe(
      "500 Internal Server Error",
    );
    expect(piFailure(end({ role: "assistant", content: [], stopReason: "aborted" }))).toBe("the model request failed");
  });

  it("gives undefined for any other line", () => {
    expect(piFailure(end({ role: "assistant", content: [], stopReason: "stop" }))).toBeUndefined();
    expect(piFailure(end({ role: "toolResult", stopReason: "error" }))).toBeUndefined();
    expect(piFailure(JSON.stringify({ type: "turn_end", message: { role: "assistant", stopReason: "error" } }))).toBeUndefined();
    expect(piFailure("not json")).toBeUndefined();
  });
});

describe("getProvider", () => {
  it("returns the pi provider when pi is on the PATH", async () => {
    expect((await getProvider("pi", worktree)).name).toBe("pi");
  });

  it("fails fast when pi is not on the PATH", async () => {
    process.env.PATH = [worktree, "/usr/bin", "/bin"].join(path.delimiter);
    await expect(getProvider("pi", worktree)).rejects.toThrow(/"pi" CLI was not found on the PATH/);
  });
});
