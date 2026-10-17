import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { CONFIG_FILE } from "../config/config.js";
import { taskSchema, type Task } from "../graph/task.js";
import { createFakeProvider, type FakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { AgentRun, AgentRunOptions, Provider } from "../providers/types.js";
import { stateSchema } from "../state/state.js";
import { RunEmitter } from "./events.js";
import { run } from "./run.js";
import { startup } from "./startup.js";

const spec = fileURLToPath(new URL("../__fixtures__/spec.md", import.meta.url));

let repo: string;
let lines: string[];
const log = (line: string): void => {
  lines.push(line);
};

beforeEach(async () => {
  repo = await tempRepo();
  lines = [];
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const node = (code: string): string => `node -e ${JSON.stringify(code)}`;
/** Fails, printing the content of `status.txt`, unless the worktree's `status.txt` says `ok`. */
const CHECK_STATUS = node(
  `const s = require("fs").readFileSync("status.txt", "utf8").trim(); if (s !== "ok") { console.error("status is " + s); process.exit(1); }`,
);
const broken = { write: { "status.txt": "broken\n" } };
const fixed = { write: { "status.txt": "ok\n" } };

/** The task agents' calls, without the reviewer's. */
const taskCalls = (provider: FakeProvider): AgentRunOptions[] => provider.calls.filter((c) => c.role === "task");

const task = (id: string, extra: Partial<Task> = {}): Task => taskSchema.parse({ id, content: `Do ${id}.`, ...extra });

async function runTasks(
  tasks: Task[],
  script: unknown = {},
  config?: unknown,
  wrap?: (p: Provider) => Provider,
  events?: RunEmitter,
) {
  if (config !== undefined) await writeFile(path.join(repo, CONFIG_FILE), JSON.stringify(config));
  const provider = createFakeProvider(fakeScriptSchema.parse(script));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: wrap ? wrap(provider) : provider, log });
  const result = await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, concurrency: 1, events });
  const state = stateSchema.parse(JSON.parse(await readFile(path.join(ctx.runDir, "state.json"), "utf8")));
  return { provider, ctx, result, state };
}

describe("validation gate", () => {
  it("sends a failing command's output back to the same agent and merges once it passes", async () => {
    const { provider, ctx, result, state } = await runTasks([task("1")], { "task:1": { attempts: [broken, fixed] } }, {
      validate: [CHECK_STATUS],
    });
    expect(result.exitCode).toBe(0);
    expect(taskCalls(provider)).toHaveLength(2);
    const [first, second] = taskCalls(provider);
    expect(second!.cwd).toBe(first!.cwd);
    expect(second!.prompt).toContain(CHECK_STATUS);
    expect(second!.prompt).toContain("status is broken");
    expect(second!.prompt).toContain("commit");
    expect(state.tasks["1"]).toMatchObject({ status: "merged", attempts: 1 });
    expect(await gitOut(repo, ["show", `graph/${ctx.runId}:status.txt`])).toBe("ok");
    expect(lines.some((l) => l.includes("fix round 1/3"))).toBe(true);
  });

  it("shows the fix round: its events, its messages and the failing output in a log file", async () => {
    const events = new RunEmitter();
    const statuses: string[] = [];
    events.on("task:status", ({ status, round, rounds }) => statuses.push(round ? `${status} ${round}/${rounds}` : status));
    const { ctx, result } = await runTasks(
      [task("1")],
      { "task:1": { attempts: [broken, fixed] } },
      { validate: [CHECK_STATUS] },
      undefined,
      events,
    );
    expect(result.exitCode).toBe(0);
    expect(statuses).toEqual(["validating", "fixing 1/3", "validating 1/3", "merging"]);
    expect(lines).toContain(`task 1: validation failed: \`${CHECK_STATUS}\` failed (exit code 1); output in logs/1-validate-1.log`);
    expect(lines).toContain("task 1: sent back to the agent to fix it (fix round 1/3)");
    expect(lines).toContain("task 1: validating again after fix round 1/3");
    expect(lines).toContain("task 1: validation passed after 1 fix round(s)");
    const saved = await readFile(path.join(ctx.runDir, "logs", "1-validate-1.log"), "utf8");
    expect(saved).toContain(`$ ${CHECK_STATUS}`);
    expect(saved).toContain("status is broken");
  });

  it("aborts with exit code 2 after 3 failed fix rounds", async () => {
    const { provider, result, state } = await runTasks(
      [task("1"), task("2", { dependencies: ["1"] })],
      { "task:1": { attempts: [broken, broken, broken, broken] } },
      { validate: [CHECK_STATUS] },
    );
    expect(result.exitCode).toBe(2);
    expect(taskCalls(provider).map((c) => c.label)).toEqual(["1", "1", "1", "1"]);
    expect(state.tasks["1"]).toMatchObject({ status: "failed", attempts: 1 });
    expect(state.tasks["2"]!.status).toBe("pending");
    expect(lines.some((l) => l.startsWith("aborted at task 1: validation failed after 3 rounds"))).toBe(true);
  });

  it("honours validationRounds from the config", async () => {
    const { provider, result } = await runTasks([task("1")], { "task:1": { attempts: [broken, broken] } }, {
      validate: [CHECK_STATUS],
      validationRounds: 1,
    });
    expect(result.exitCode).toBe(2);
    expect(taskCalls(provider)).toHaveLength(2);
    expect(lines.some((l) => l.includes("validation failed after 1 rounds"))).toBe(true);
  });

  it("skips the gate for a task with validate: false and uses the config for null or absent", async () => {
    const tasks = [task("1", { validate: false }), task("2", { validate: null }), task("3")];
    const { provider, result } = await runTasks(
      tasks,
      { "task:1": { attempts: [broken] }, "task:2": { attempts: [broken, fixed] }, "task:3": { attempts: [broken, fixed] } },
      { validate: [CHECK_STATUS] },
    );
    expect(result.exitCode).toBe(0);
    expect(taskCalls(provider).map((c) => c.label)).toEqual(["1", "2", "2", "3", "3"]);
  });

  it("runs a task's own validate list instead of the config's", async () => {
    const { provider, result, state } = await runTasks(
      [task("1", { validate: [CHECK_STATUS] })],
      { "task:1": { attempts: [broken, fixed] } },
      { validate: [node("process.exit(1)")] },
    );
    expect(taskCalls(provider)).toHaveLength(2);
    expect(state.tasks["1"]!.status).toBe("merged");
    // The config's list still gates the integration branch before the review.
    expect(result.exitCode).toBe(2);
    expect(lines.some((l) => l.includes("failed before the review"))).toBe(true);
  });

  it("does not spend task attempts on fix rounds", async () => {
    const crash = { exitCode: 1, commit: false };
    const { result, state } = await runTasks(
      [task("1")],
      { "task:1": { attempts: [crash, crash, broken, broken, fixed] } },
      { validate: [CHECK_STATUS] },
    );
    expect(result.exitCode).toBe(0);
    expect(state.tasks["1"]).toMatchObject({ status: "merged", attempts: 3 });
  });

  it("requires a commit from a fix round and retries it", async () => {
    const { provider, result } = await runTasks(
      [task("1")],
      { "task:1": { attempts: [broken, { ...fixed, commit: false }, fixed] } },
      { validate: [CHECK_STATUS] },
    );
    expect(result.exitCode).toBe(0);
    expect(taskCalls(provider)).toHaveLength(3);
    expect(lines.some((l) => l.includes("the agent made no commit; fix round 1 retry 2/3"))).toBe(true);
  });

  it("persists the validating status while the fix round runs", async () => {
    const statuses: string[] = [];
    const { result } = await runTasks(
      [task("1")],
      { "task:1": { attempts: [broken, fixed] } },
      { validate: [CHECK_STATUS] },
      (p) => ({
        name: p.name,
        run(opts): AgentRun {
          if (opts.role !== "task") return p.run(opts);
          // Worktrees live in `<runDir>/worktrees/`, next to state.json.
          const stateFile = path.join(opts.cwd, "..", "..", "state.json");
          const status = stateSchema.parse(JSON.parse(readFileSync(stateFile, "utf8"))).tasks["1"]!.status;
          statuses.push(status);
          return p.run(opts);
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(statuses).toEqual(["running", "validating"]);
  });
});

describe("setup commands", () => {
  it("run once in every new task worktree before the agent starts", async () => {
    const setupLog = path.join(repo, ".git", "setup.log");
    const setup = node(`require("fs").appendFileSync(${JSON.stringify(setupLog)}, require("path").basename(process.cwd()) + "\\n")`);
    const seenAtStart: string[] = [];
    const crash = { exitCode: 1, commit: false };
    const { result } = await runTasks(
      [task("1"), task("2", { dependencies: ["1"] })],
      { "task:2": { attempts: [crash] } },
      { setup: [setup] },
      (p) => ({
        name: p.name,
        run(opts): AgentRun {
          seenAtStart.push(path.basename(opts.cwd));
          return p.run(opts);
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    const ran = (await readFile(setupLog, "utf8")).trim().split("\n");
    // The two reviewers run in parallel, so their order is not fixed.
    expect(ran.slice(0, 3)).toEqual(["task-1-a1", "task-2-a1", "task-2-a2"]);
    expect(ran.slice(3).sort()).toEqual(["review-code-r0", "review-tester-r0"]);
    expect(seenAtStart.slice(0, 3)).toEqual(ran.slice(0, 3));
    expect(seenAtStart.slice().sort()).toEqual(ran.slice().sort());
  });

  it("aborts the run with exit code 2 when a setup command fails", async () => {
    const { provider, result, state } = await runTasks([task("1")], {}, { setup: [node("process.exit(5)")] });
    expect(result.exitCode).toBe(2);
    expect(taskCalls(provider)).toHaveLength(0);
    expect(state.tasks["1"]!.status).toBe("failed");
    expect(lines.some((l) => l.startsWith("aborted at task 1: setup command") && l.includes("exit code 5"))).toBe(true);
  });
});

describe("config", () => {
  it("runs exactly as before without a config file", async () => {
    const { provider, result, state } = await runTasks([task("1", { validate: null })]);
    expect(result.exitCode).toBe(0);
    expect(taskCalls(provider)).toHaveLength(1);
    expect(state.tasks["1"]!.status).toBe("merged");
  });

  it("refuses to start with an unknown config key", async () => {
    await writeFile(path.join(repo, CONFIG_FILE), JSON.stringify({ validat: [] }));
    await expect(startup({ cwd: repo, provider: "fake", providerInstance: createFakeProvider(), log })).rejects.toThrow(
      /validat/,
    );
  });
});
