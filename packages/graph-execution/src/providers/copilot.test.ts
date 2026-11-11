import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COPILOT_ARGS_ENV, copilotArgs, copilotProvider, parseCopilotLine } from "./copilot.js";
import { writeFakeBin } from "../__fixtures__/fake-bin.js";
import { getProvider } from "./index.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

/**
 * Fake `copilot`: records `{argv, cwd, stdin, autoUpdate}` to $FAKE_COPILOT_RECORD, creates
 * $COPILOT_HOME/session-state/<session id>/x, prints JSON lines and exits with $FAKE_COPILOT_EXIT. With
 * $FAKE_COPILOT_HANG it writes its pid to $FAKE_COPILOT_RECORD.pid and never exits.
 */
const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_COPILOT_RECORD, JSON.stringify({ argv, cwd: process.cwd(), stdin: fs.readFileSync(0, "utf8"), autoUpdate: process.env.COPILOT_AUTO_UPDATE ?? null }));
const id = argv[argv.indexOf("--session-id") + 1];
const dir = path.join(process.env.COPILOT_HOME, "session-state", id);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "x"), "");
console.log(JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "hel" } }));
console.log(JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "hello", toolRequests: [{ toolCallId: "c1", name: "bash", arguments: { command: "ls" }, type: "function" }] } }));
console.log(JSON.stringify({ type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "ls" } } }));
console.log(JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "a\\n" } } }));
console.log(JSON.stringify({ type: "result", sessionId: id, exitCode: 0, usage: {} }));
console.error("warning: plain text");
if (process.env.FAKE_COPILOT_HANG) {
  fs.writeFileSync(process.env.FAKE_COPILOT_RECORD + ".pid", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(Number(process.env.FAKE_COPILOT_EXIT ?? 0));
}
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_KEYS = [
  "PATH",
  "COPILOT_HOME",
  "FAKE_COPILOT_RECORD",
  "FAKE_COPILOT_EXIT",
  "FAKE_COPILOT_HANG",
  COPILOT_ARGS_ENV,
] as const;
let saved: Record<string, string | undefined>;
let binDir: string;
let worktree: string;
let home: string;
let record: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  binDir = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "graph-execution-wt-")));
  home = await mkdtemp(path.join(tmpdir(), "graph-execution-copilot-home-"));
  record = path.join(binDir, "record.json");
  await writeFakeBin(path.join(binDir, "copilot"), FAKE_COPILOT);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.COPILOT_HOME = home;
  process.env.FAKE_COPILOT_RECORD = record;
  delete process.env.FAKE_COPILOT_EXIT;
  delete process.env.FAKE_COPILOT_HANG;
  delete process.env[COPILOT_ARGS_ENV];
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of [binDir, worktree, home]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

const recorded = async (): Promise<{ argv: string[]; cwd: string; stdin: string; autoUpdate: string | null }> =>
  JSON.parse(await readFile(record, "utf8"));

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
  return readFile(file, "utf8");
}

describe("copilot provider", () => {
  it("runs copilot headless in the worktree with the prompt on stdin and streams its output", async () => {
    const run = copilotProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 0 });
    const stderrLine = { type: "output", text: "warning: plain text\n" };
    expect(events).toContainEqual(stderrLine);
    expect(events.filter((e) => !(e.type === "output" && e.text === stderrLine.text))).toEqual([
      { type: "output", text: "hello\n" },
      { type: "tool", name: "bash", input: { command: "ls" } },
      { type: "exit", code: 0 },
    ]);
    const rec = await recorded();
    expect(rec.argv.slice(0, 5)).toEqual(["--output-format", "json", "--allow-all", "--no-auto-update", "--session-id"]);
    expect(rec.argv[5]).toMatch(UUID);
    expect(rec.argv).toHaveLength(6);
    expect(rec.argv).not.toContain("-p");
    expect(rec.cwd).toBe(worktree);
    expect(rec.stdin).toBe("do it; rm -rf / # not a shell");
    expect(rec.autoUpdate).toBe("false");
  });

  it("removes the run's session-state folder before done resolves, and uses a fresh session id per run", async () => {
    await copilotProvider.run(opts()).done;
    const first = (await recorded()).argv[5];
    expect(await readdir(path.join(home, "session-state"))).toEqual([]);
    await copilotProvider.run(opts()).done;
    expect((await recorded()).argv[5]).not.toBe(first);
    expect(await readdir(path.join(home, "session-state"))).toEqual([]);
  });

  it("passes --model and appends extra args from the env", async () => {
    process.env[COPILOT_ARGS_ENV] = ` --add-dir "/a b"  --log-level debug `;
    const run = copilotProvider.run(opts({ model: "claude-sonnet-5.5", prompt: "--help" }));
    await run.done;
    const rec = await recorded();
    expect(rec.argv.slice(6)).toEqual(["--model", "claude-sonnet-5.5", "--add-dir", "/a b", "--log-level", "debug"]);
    expect(rec.stdin).toBe("--help");
  });

  it("surfaces a non-zero exit code and still removes the session folder", async () => {
    process.env.FAKE_COPILOT_EXIT = "1";
    const run = copilotProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 1 });
    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
    expect(await readdir(path.join(home, "session-state"))).toEqual([]);
  });

  it("kills the child when the signal aborts", async () => {
    process.env.FAKE_COPILOT_HANG = "1";
    const controller = new AbortController();
    const run = copilotProvider.run(opts({ signal: controller.signal }));
    const pid = Number(await waitFor(`${record}.pid`));
    controller.abort();
    expect((await run.done).exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(path.join(home, "session-state"))).toEqual([]);
  });

  it("rejects done with a clear message when copilot cannot be started", async () => {
    process.env.PATH = worktree;
    const run = copilotProvider.run(opts());
    await expect(run.done).rejects.toThrow(/failed to start "copilot".*ENOENT/);
    await expect(collect(run.events)).rejects.toThrow(/ENOENT/);
  });
});

describe("copilotArgs", () => {
  it("always passes --allow-all and never -p", () => {
    expect(copilotArgs({}, {})).toEqual(["--output-format", "json", "--allow-all", "--no-auto-update"]);
  });

  it("throws on a malformed args env", () => {
    expect(() => copilotArgs({}, { [COPILOT_ARGS_ENV]: `--x "unterminated` })).toThrow();
  });
});

describe("parseCopilotLine", () => {
  it("returns the content of an assistant message, or nothing when it is empty", () => {
    expect(parseCopilotLine(JSON.stringify({ type: "assistant.message", data: { content: "Let me look." } }))).toBe(
      "Let me look.\n",
    );
    expect(parseCopilotLine(JSON.stringify({ type: "assistant.message", data: { content: "", toolRequests: [] } }))).toBe(
      "",
    );
  });

  it("reports a session error", () => {
    const line = JSON.stringify({ type: "session.error", data: { errorType: "model", message: "rate limited", statusCode: 429 } });
    expect(parseCopilotLine(line)).toBe("copilot: rate limited\n");
  });

  it("drops the other JSON events and passes non-JSON lines through", () => {
    expect(parseCopilotLine(JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "Let" } }))).toBe("");
    expect(parseCopilotLine(JSON.stringify({ type: "tool.execution_start", data: { toolName: "bash" } }))).toBe("");
    expect(parseCopilotLine('{"type":"result","exitCode":0}')).toBe("");
    expect(parseCopilotLine("not json")).toBe("not json\n");
  });
});

describe("getProvider", () => {
  it("returns the copilot provider when copilot is on the PATH", async () => {
    expect((await getProvider("copilot", worktree)).name).toBe("copilot");
  });

  it("fails fast when copilot is not on the PATH", async () => {
    process.env.PATH = [worktree, "/usr/bin", "/bin"].join(path.delimiter);
    await expect(getProvider("copilot", worktree)).rejects.toThrow(/"copilot" CLI was not found on the PATH/);
  });
});
