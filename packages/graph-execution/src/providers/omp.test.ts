import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OMP_ARGS_ENV, ompProvider } from "./omp.js";
import { writeFakeBin } from "../__fixtures__/fake-bin.js";
import { getProvider } from "./index.js";
import type { AgentEvent, AgentRunOptions } from "./types.js";

/**
 * Fake `omp` (a node script; the real one runs on Bun): records `{argv, cwd, stdin}` to $FAKE_OMP_RECORD, prints
 * `--mode json` events and exits with $FAKE_OMP_EXIT. With $FAKE_OMP_FAIL the last assistant message fails.
 * With $FAKE_OMP_HANG it writes its pid to $FAKE_OMP_RECORD.pid and never exits.
 */
const FAKE_OMP = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_OMP_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, "utf8") }));
const out = (e) => console.log(JSON.stringify(e));
out({ type: "session", version: 3, id: "s", cwd: process.cwd() });
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "toolUse" } });
out({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.txt" }, streamIndex: 0 });
out({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false, duration: 3 });
if (process.env.FAKE_OMP_FAIL) out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota" } });
console.error("warning: plain text");
if (process.env.FAKE_OMP_HANG) {
  fs.writeFileSync(process.env.FAKE_OMP_RECORD + ".pid", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(Number(process.env.FAKE_OMP_EXIT ?? 0));
}
`;

const ENV_KEYS = ["PATH", "FAKE_OMP_RECORD", "FAKE_OMP_EXIT", "FAKE_OMP_HANG", "FAKE_OMP_FAIL", OMP_ARGS_ENV] as const;
let saved: Record<string, string | undefined>;
let binDir: string;
let worktree: string;
let record: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  binDir = await mkdtemp(path.join(tmpdir(), "graph-execution-bin-"));
  worktree = await realpath(await mkdtemp(path.join(tmpdir(), "graph-execution-wt-")));
  record = path.join(binDir, "record.json");
  await writeFakeBin(path.join(binDir, "omp"), FAKE_OMP);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_OMP_RECORD = record;
  delete process.env.FAKE_OMP_EXIT;
  delete process.env.FAKE_OMP_HANG;
  delete process.env.FAKE_OMP_FAIL;
  delete process.env[OMP_ARGS_ENV];
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
  prompt: "do it; rm -rf / # not a shell\n",
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

const STDERR_TEXT = "warning: plain text\n";

describe("omp provider", () => {
  it("runs omp with --auto-approve in the worktree, prompt on stdin, and streams its text and tool calls", async () => {
    const run = ompProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 0 });
    expect(events).toContainEqual({ type: "output", text: STDERR_TEXT });
    expect(events.filter((e) => !(e.type === "output" && e.text === STDERR_TEXT))).toEqual([
      { type: "output", text: "hello\n" },
      { type: "tool", name: "read", input: { path: "a.txt" } },
      { type: "exit", code: 0 },
    ]);
    expect(await recorded()).toEqual({
      argv: ["--mode", "json", "--no-session", "--auto-approve"],
      cwd: worktree,
      stdin: "do it; rm -rf / # not a shell\n",
    });
  });

  it("passes --model and appends extra args from the env", async () => {
    process.env[OMP_ARGS_ENV] = ` --thinking high --x 'a b'`;
    const run = ompProvider.run(opts({ model: "openai/gpt-5" }));
    await run.done;
    expect((await recorded()).argv).toEqual([
      "--mode",
      "json",
      "--no-session",
      "--auto-approve",
      "--model",
      "openai/gpt-5",
      "--thinking",
      "high",
      "--x",
      "a b",
    ]);
  });

  it("surfaces a non-zero exit code", async () => {
    process.env.FAKE_OMP_EXIT = "53";
    const run = ompProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 53 });
    expect(events.at(-1)).toEqual({ type: "exit", code: 53 });
  });

  it("fails the attempt when the last assistant message failed", async () => {
    process.env.FAKE_OMP_FAIL = "1";
    const run = ompProvider.run(opts());
    const [events, done] = await Promise.all([collect(run.events), run.done]);
    expect(done).toEqual({ exitCode: 1 });
    expect(events).toContainEqual({ type: "output", text: "omp: quota\n" });
    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
  });

  it("kills the child when the signal aborts", async () => {
    process.env.FAKE_OMP_HANG = "1";
    const controller = new AbortController();
    const run = ompProvider.run(opts({ signal: controller.signal }));
    const pid = Number(await waitFor(`${record}.pid`));
    controller.abort();
    expect((await run.done).exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects done with a clear message when omp cannot be started", async () => {
    process.env.PATH = worktree;
    const run = ompProvider.run(opts());
    await expect(run.done).rejects.toThrow(/failed to start "omp".*ENOENT/);
    await expect(collect(run.events)).rejects.toThrow(/ENOENT/);
  });
});

describe("getProvider", () => {
  it("fails fast when omp is not on the PATH", async () => {
    process.env.PATH = [worktree, "/usr/bin", "/bin"].join(path.delimiter);
    await expect(getProvider("omp", worktree)).rejects.toThrow(/"omp" CLI was not found on the PATH/);
  });

  it("fails fast when omp is on the PATH but Bun is not", async () => {
    process.env.PATH = [binDir, path.dirname(process.execPath)].join(path.delimiter);
    await expect(getProvider("omp", worktree)).rejects.toThrow(/needs Bun/);
  });

  it("returns the omp provider when omp and Bun are on the PATH", async () => {
    await writeFakeBin(path.join(binDir, "bun"), "#!/usr/bin/env node\n");
    process.env.PATH = [binDir, path.dirname(process.execPath)].join(path.delimiter);
    expect((await getProvider("omp", worktree)).name).toBe("omp");
  });
});
