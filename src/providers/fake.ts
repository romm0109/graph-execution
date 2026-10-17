import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { REPORT_PATH_PATTERN } from "../review/report.js";
import { spawnAgent } from "./spawn.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "./types.js";

/** Env var holding the path of the fake provider's JSON script. */
export const FAKE_SCRIPT_ENV = "GRAPH_EXECUTION_FAKE_SCRIPT";

/** Env var naming a file every run appends its `<role>:<label>` line to, so out-of-process tests can count runs. */
export const FAKE_LOG_ENV = "GRAPH_EXECUTION_FAKE_LOG";

/** File a `hang` attempt's child process writes its pid to, in the agent's cwd. */
export const FAKE_PID_FILE = ".fake-agent.pid";

/** File an `orphan` attempt's agent writes the pid of the background process it leaves running to. */
export const FAKE_ORPHAN_PID_FILE = ".fake-orphan.pid";

/** One scripted agent run. Unknown keys are ignored so later issues can extend the format. */
const attemptSchema = z.looseObject({
  /** Files to write into the worktree; defaults to `<id>.txt`. */
  write: z.record(z.string(), z.string()).optional(),
  commit: z.boolean().default(true),
  exitCode: z.number().int().default(0),
  /** Simulates a provider error: the run rejects with this message instead of exiting. */
  throw: z.string().optional(),
  /** Spawns a real child process that runs until the signal aborts it; `exitCode` is then the kill's exit code. */
  hang: z.boolean().default(false),
  /** Spawns a real agent process that starts a background process in its group and exits without stopping it. */
  orphan: z.boolean().default(false),
  /**
   * Reviewer runs only: the report written to the path named in the prompt. An object is written as JSON, with
   * `round` and `reviewer` filled in from the label (`code-r<N>`); a string is written as is; `null` writes nothing.
   * Absent means a valid report without findings.
   */
  report: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/** `{ "<role>:<label>": { "attempts": [...] } }`; attempts are consumed in order per key. */
export const fakeScriptSchema = z.record(z.string(), z.looseObject({ attempts: z.array(attemptSchema).default([]) }));

export type FakeScript = z.infer<typeof fakeScriptSchema>;
export type FakeAttempt = z.infer<typeof attemptSchema>;

export interface FakeProvider extends Provider {
  /** Every run so far, in order, so tests can assert on prompts. */
  calls: AgentRunOptions[];
  /** Pids of the child processes spawned by `hang` attempts and of the background processes of `orphan` ones. */
  pids: number[];
}

export interface FakeProviderOptions {
  /** Called once a `hang` attempt's child process is running. */
  onSpawn?: (pid: number, opts: AgentRunOptions) => void;
}

export async function loadFakeScript(file: string | undefined = process.env[FAKE_SCRIPT_ENV]): Promise<FakeScript> {
  if (!file) return {};
  return fakeScriptSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

async function writeReport(opts: AgentRunOptions, attempt: FakeAttempt): Promise<void> {
  const file = REPORT_PATH_PATTERN.exec(opts.prompt)?.[1];
  if (!file || attempt.report === null) return;
  let content: string;
  if (typeof attempt.report === "string") content = attempt.report;
  else {
    const [reviewer, round] = opts.label.split(/-r(?=\d+$)/);
    content = JSON.stringify({ round: Number(round), reviewer, findings: [], ...attempt.report });
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Deterministic provider for tests: writes files and commits as scripted instead of running an AI agent. */
export function createFakeProvider(script: FakeScript = {}, options: FakeProviderOptions = {}): FakeProvider {
  const consumed = new Map<string, number>();
  const calls: AgentRunOptions[] = [];
  const pids: number[] = [];

  const nextAttempt = (key: string): FakeAttempt | undefined => {
    const n = consumed.get(key) ?? 0;
    consumed.set(key, n + 1);
    return script[key]?.attempts[n];
  };

  const execute = async (opts: AgentRunOptions, key: string, attemptNo: number): Promise<AgentEvent[]> => {
    const attempt = nextAttempt(key) ?? attemptSchema.parse({});
    const files = attempt.write ?? { [`${opts.label}.txt`]: `${opts.label}\n` };
    const events: AgentEvent[] = [];
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(opts.cwd, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      events.push({ type: "output", text: `wrote ${name}\n` });
    }
    if (opts.role === "reviewer" || opts.role === "tester") await writeReport(opts, attempt);
    if (attempt.throw !== undefined) throw new Error(attempt.throw);
    if (attempt.orphan) {
      const child = [
        `const bg = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });`,
        `require("fs").writeFileSync(${JSON.stringify(FAKE_ORPHAN_PID_FILE)}, String(bg.pid));`,
        "bg.unref();",
      ].join(" ");
      const code = await spawnAgent(process.execPath, ["-e", child], opts).exitCode;
      pids.push(Number(await readFile(path.join(opts.cwd, FAKE_ORPHAN_PID_FILE), "utf8")));
      events.push({ type: "exit", code });
      return events;
    }
    if (attempt.hang) {
      // The child records its pid in the worktree so out-of-process tests can find it.
      const child = `require("fs").writeFileSync(${JSON.stringify(FAKE_PID_FILE)}, String(process.pid)); setInterval(() => {}, 1 << 30);`;
      const agent = spawnAgent(process.execPath, ["-e", child], opts);
      pids.push(agent.child.pid!);
      options.onSpawn?.(agent.child.pid!, opts);
      events.push({ type: "exit", code: await agent.exitCode });
      return events;
    }
    if (attempt.commit) {
      await execa("git", ["add", "-A"], { cwd: opts.cwd });
      await execa("git", ["commit", "--allow-empty", "-m", `fake: ${key} attempt ${attemptNo}`], { cwd: opts.cwd });
    }
    events.push({ type: "exit", code: attempt.exitCode });
    return events;
  };

  return {
    name: "fake",
    calls,
    pids,
    run(opts: AgentRunOptions): AgentRun {
      calls.push(opts);
      const key = `${opts.role}:${opts.label}`;
      const logFile = process.env[FAKE_LOG_ENV];
      if (logFile) appendFileSync(logFile, `${key}\n`);
      const work = execute(opts, key, (consumed.get(key) ?? 0) + 1);
      const done = work.then((events) => {
        const exit = events.at(-1);
        return { exitCode: exit?.type === "exit" ? exit.code : 0 };
      });
      async function* events(): AsyncIterable<AgentEvent> {
        yield* await work;
      }
      return { events: events(), done };
    },
  };
}
