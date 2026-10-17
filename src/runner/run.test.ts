import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { COMMIT_INSTRUCTION } from "../agents/task.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { AgentRun, Provider } from "../providers/types.js";
import { stateSchema } from "../state/state.js";
import { phaseLabel } from "./events.js";
import { run } from "./run.js";
import { startup } from "./startup.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
const spec = fixture("spec.md");

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

const readState = async (runDir: string) =>
  stateSchema.parse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));

async function runDiamond(provider: Provider = createFakeProvider(), concurrency?: number) {
  const tasks = await loadTasks(fixture("diamond"));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
  const result = await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, concurrency });
  return { ctx, tasks, result };
}

describe("run", () => {
  it("executes the diamond end to end through the integration branch", async () => {
    const before = await gitOut(repo, ["rev-parse", "HEAD"]);
    const { ctx, result } = await runDiamond();
    expect(result.exitCode).toBe(0);

    const branch = `graph/${ctx.runId}`;
    expect(ctx.runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect((await gitOut(repo, ["ls-tree", "--name-only", branch])).split("\n").sort()).toEqual(
      ["1.txt", "2.txt", "3.txt", "4.txt", "README.md"],
    );
    expect(await gitOut(repo, ["rev-list", "--count", "--merges", branch])).toBe("4");

    const raw = JSON.parse(await readFile(path.join(ctx.runDir, "state.json"), "utf8"));
    const state = stateSchema.parse(raw);
    expect(state.startingCommit).toBe(before);
    expect(state.integrationBranch).toBe(branch);
    expect(Object.values(state.tasks).map((t) => t.status)).toEqual(["merged", "merged", "merged", "merged"]);
    for (const t of Object.values(state.tasks)) {
      expect(await gitOut(repo, ["merge-base", "--is-ancestor", t.mergeCommit!, branch])).toBe("");
    }
    expect(await readdir(ctx.runDir)).not.toContain("state.json.tmp");
    // Task worktrees are removed after merge and the integration worktree at the end of a successful run.
    expect(existsSync(path.join(ctx.runDir, "worktrees"))).toBe(false);
    expect(await gitOut(repo, ["worktree", "list"])).not.toContain(ctx.runId);

    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
    expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await gitOut(repo, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("sends task prompts with only the task content and the commit instruction", async () => {
    const provider = createFakeProvider();
    const { tasks } = await runDiamond(provider);
    const specText = await readFile(spec, "utf8");
    const taskCalls = provider.calls.filter((c) => c.role === "task");
    expect(taskCalls.map((c) => c.label)).toEqual(["1", "2", "3", "4"]);
    for (const call of taskCalls) {
      const task = tasks.find((t) => t.id === call.label)!;
      expect(call.role).toBe("task");
      expect(call.prompt).toBe(`${task.content}\n\n${COMMIT_INSTRUCTION}\n`);
      expect(call.prompt).not.toContain(specText.trim());
    }
  });

  it("retries a task that crashes twice and succeeds on the third attempt in a fresh worktree", async () => {
    const script = fakeScriptSchema.parse({
      "task:2": {
        attempts: [
          { write: { "junk-a1.txt": "x" }, commit: true, exitCode: 1 },
          { write: { "junk-a2.txt": "x" }, commit: false, throw: "provider blew up" },
        ],
      },
    });
    const provider = createFakeProvider(script);
    const { ctx, result } = await runDiamond(provider);
    expect(result.exitCode).toBe(0);

    const state = await readState(ctx.runDir);
    expect(state.tasks["2"]).toMatchObject({ status: "merged", attempts: 3 });
    expect(state.tasks["1"]!.attempts).toBe(1);
    expect(provider.calls.filter((c) => c.label === "2").map((c) => path.basename(c.cwd))).toEqual([
      "task-2-a1",
      "task-2-a2",
      "task-2-a3",
    ]);
    // Neither the committed nor the uncommitted files of failed attempts reach the integration branch.
    const files = (await gitOut(repo, ["ls-tree", "--name-only", `graph/${ctx.runId}`])).split("\n");
    expect(files).not.toContain("junk-a1.txt");
    expect(files).not.toContain("junk-a2.txt");
    expect(existsSync(path.join(ctx.runDir, "worktrees"))).toBe(false);
    expect(lines).toContain("task 2: agent exited with code 1; retry 2/3");
    expect(lines).toContain("task 2: provider blew up; retry 3/3");
  });

  it("aborts with exit code 2 after three crashes, keeping state, branches and the worktree", async () => {
    const crash = { exitCode: 1, commit: false };
    const script = fakeScriptSchema.parse({ "task:2": { attempts: [crash, crash, crash] } });
    const provider = createFakeProvider(script);
    const { ctx, result } = await runDiamond(provider, 1);
    expect(result.exitCode).toBe(2);

    const state = await readState(ctx.runDir);
    expect(state.tasks["1"]!.status).toBe("merged");
    expect(state.tasks["2"]).toMatchObject({ status: "failed", attempts: 3 });
    expect(state.tasks["3"]!.status).toBe("pending");
    expect(provider.calls.map((c) => c.label)).toEqual(["1", "2", "2", "2"]);
    expect((await readdir(path.join(ctx.runDir, "worktrees"))).sort()).toEqual(["integration", "task-2-a3"]);
    expect(await gitOut(repo, ["branch", "--list", `graph-task/${ctx.runId}/2`])).not.toBe("");
    expect(lines).toContain(`to resume: graph-execution --resume --run ${ctx.runId}`);
    expect(lines.some((l) => l.startsWith("aborted at task 2: task 2 failed after 3 attempts"))).toBe(true);
  });

  it("writes every agent's output to logs/<label>.log and drives the UI through the events", async () => {
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: createFakeProvider(), log });
    const seen: string[] = [];
    let layers: string[][] = [];
    const result = await run(ctx, tasks, {
      specPath: spec,
      tasksDir: "tasks",
      log,
      ui: (opts) => {
        layers = opts.layers;
        opts.events.on("task:start", ({ taskId }) => seen.push(`start ${taskId}`));
        opts.events.on("task:status", ({ taskId, status }) => seen.push(`${status} ${taskId}`));
        opts.events.on("phase:change", (change) => seen.push(`phase ${phaseLabel(change)}`));
        return { log, stop: () => seen.push("stop") };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(layers).toEqual([["1"], ["2", "3"], ["4"]]);
    expect(seen).toContain("merging 1");
    expect(seen.slice(0, 2)).toEqual(["phase tasks", "start 1"]);
    expect(seen).toContain("phase review round 0");
    expect(seen.at(-1)).toBe("stop");

    const logsDir = path.join(ctx.runDir, "logs");
    expect((await readdir(logsDir)).filter((f) => /^\d\.log$/.test(f)).sort()).toEqual(["1.log", "2.log", "3.log", "4.log"]);
    expect(await readFile(path.join(logsDir, "2.log"), "utf8")).toContain("wrote 2.txt");
  });

  it("stops the UI before printing the abort message", async () => {
    const crash = { exitCode: 1, commit: false };
    const script = fakeScriptSchema.parse({ "task:1": { attempts: [crash, crash, crash] } });
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: createFakeProvider(script), log });
    const result = await run(ctx, tasks, {
      specPath: spec,
      tasksDir: "tasks",
      log,
      ui: () => ({ log, stop: () => lines.push("<ui stopped>") }),
    });
    expect(result.exitCode).toBe(2);
    const stopped = lines.indexOf("<ui stopped>");
    const aborted = lines.findIndex((l) => l.startsWith("aborted at task 1"));
    expect(stopped).toBeGreaterThan(-1);
    expect(aborted).toBeGreaterThan(stopped);
  });

  it("counts an attempt without a commit as a failure", async () => {
    const script = fakeScriptSchema.parse({ "task:1": { attempts: [{ commit: false }] } });
    const provider = createFakeProvider(script);
    const { ctx, result } = await runDiamond(provider);
    expect(result.exitCode).toBe(0);
    expect((await readState(ctx.runDir)).tasks["1"]).toMatchObject({ status: "merged", attempts: 2 });
    expect(lines).toContain("task 1: the agent made no commit; retry 2/3");
  });

  it("on abort kills the running agent, keeps the task running and starts no further attempt", async () => {
    const controller = new AbortController();
    const script = fakeScriptSchema.parse({ "task:2": { attempts: [{ hang: true }] } });
    const provider = createFakeProvider(script, { onSpawn: () => controller.abort() });
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
    const result = await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, signal: controller.signal, concurrency: 1 });
    expect(result.exitCode).toBe(2);

    expect(provider.pids).toHaveLength(1);
    expect(() => process.kill(provider.pids[0]!, 0)).toThrow();
    expect(provider.calls.map((c) => c.label)).toEqual(["1", "2"]);
    const state = await readState(ctx.runDir);
    expect(state.tasks["2"]).toMatchObject({ status: "running", attempts: 1 });
    expect(state.tasks["3"]!.status).toBe("pending");
    expect((await readdir(path.join(ctx.runDir, "worktrees"))).sort()).toEqual(["integration", "task-2-a1"]);
    expect(lines).toContain(`to resume: graph-execution --resume --run ${ctx.runId}`);
  });

  it("kills the other running agents when a parallel task exhausts its retries", async () => {
    const crash = { exitCode: 1, commit: false };
    const script = fakeScriptSchema.parse({
      "task:2": { attempts: [crash, crash, crash] },
      "task:3": { attempts: [{ hang: true }] },
    });
    let spawned!: () => void;
    const task3Spawned = new Promise<void>((resolve) => (spawned = resolve));
    const provider = createFakeProvider(script, { onSpawn: () => spawned() });
    // Task 2 only starts once task 3's agent is running, so its exhaustion must kill a live agent.
    const gated: Provider = {
      name: provider.name,
      run(opts): AgentRun {
        if (opts.label !== "2") return provider.run(opts);
        const inner = task3Spawned.then(() => provider.run(opts));
        return {
          events: (async function* () {
            yield* (await inner).events;
          })(),
          done: inner.then((r) => r.done),
        };
      },
    };
    const { ctx, result } = await runDiamond(gated, 3);
    expect(result.exitCode).toBe(2);

    expect(provider.pids).toHaveLength(1);
    expect(() => process.kill(provider.pids[0]!, 0)).toThrow();
    const state = await readState(ctx.runDir);
    expect(state.tasks["2"]).toMatchObject({ status: "failed", attempts: 3 });
    expect(state.tasks["3"]).toMatchObject({ status: "running", attempts: 1 });
    expect(state.tasks["4"]!.status).toBe("pending");
    expect((await readdir(path.join(ctx.runDir, "worktrees"))).sort()).toEqual(["integration", "task-2-a3", "task-3-a1"]);
    expect(lines.some((l) => l.startsWith("aborted at task 2: task 2 failed after 3 attempts"))).toBe(true);
  });

  it("removes its SIGINT and SIGTERM handlers when the run ends", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await runDiamond();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it("excludes .graph-execution/ exactly once after two runs", async () => {
    await runDiamond();
    await runDiamond();
    const exclude = await readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".graph-execution/")).toHaveLength(1);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
  });
});

describe("startup", () => {
  it("warns about a dirty working tree and continues", async () => {
    await writeFile(path.join(repo, "README.md"), "changed\n");
    const { result } = await runDiamond();
    expect(result.exitCode).toBe(0);
    expect(lines.some((l) => l.includes("uncommitted changes"))).toBe(true);
    expect(lines.some((l) => l.includes("full-auto"))).toBe(true);
  });

  it("refuses to start outside a git repository", async () => {
    await expect(startup({ cwd: tmpdir(), provider: "fake", log })).rejects.toThrow(/not inside a git repository/);
  });
});
