import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { alreadyDoneInstruction, COMMIT_INSTRUCTION, PROCESS_INSTRUCTION } from "../agents/task.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { AgentRun, Provider } from "../providers/types.js";
import { stateSchema } from "../state/state.js";
import { phaseLabel, RunEmitter, type RunEventMap } from "./events.js";
import { run } from "./run.js";
import { startup } from "./startup.js";
import { fixture, spec, repo, lines, log, readState, runDiamond } from "../__fixtures__/run-diamond.js";

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

    // After the clean review the result lands on the branch the run started on as uncommitted changes:
    // nothing is committed or staged, and the new files are plain untracked files.
    expect(await gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await gitOut(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect((await gitOut(repo, ["status", "--porcelain"])).split("\n").sort()).toEqual([
      "?? 1.txt",
      "?? 2.txt",
      "?? 3.txt",
      "?? 4.txt",
    ]);
    // Staged, the working tree is exactly the run's branch.
    await gitOut(repo, ["add", "-A"]);
    expect(await gitOut(repo, ["diff", "--cached", "--name-only", branch])).toBe("");
    expect(state.targetBranch).toBe("main");
  });

  it("sends task prompts with the task content, where the spec and tasks are, and the commit instruction", async () => {
    const provider = createFakeProvider();
    const { tasks, ctx } = await runDiamond(provider);
    const specText = await readFile(spec, "utf8");
    const taskCalls = provider.calls.filter((c) => c.role === "task");
    expect(taskCalls.map((c) => c.label)).toEqual(["1", "2", "3", "4"]);
    const specCopy = path.join(ctx.runDir, "context", "spec", path.basename(spec));
    for (const call of taskCalls) {
      const task = tasks.find((t) => t.id === call.label)!;
      expect(call.role).toBe("task");
      expect(call.prompt.startsWith(task.content.trimEnd())).toBe(true);
      expect(call.prompt).toContain(COMMIT_INSTRUCTION);
      expect(call.prompt).toContain(PROCESS_INSTRUCTION);
      expect(call.prompt).toContain(alreadyDoneInstruction(task));
      expect(call.prompt).toContain(`\`${specCopy}\``);
      // A pointer to the spec, not its text (PRD §7.2).
      expect(call.prompt).not.toContain(specText.trim());
      expect(call.prompt).not.toContain("## Previous attempt");
    }
    // The copies exist, outside every worktree.
    expect(await readFile(specCopy, "utf8")).toBe(specText);
    expect((await readdir(path.join(ctx.runDir, "context", "tasks"))).sort()).toEqual(["1.json", "2.json", "3.json", "4.json"]);
  });

  it("merges a task whose work already exists when it records that with an empty commit", async () => {
    const provider = createFakeProvider(fakeScriptSchema.parse({ "task:2": { attempts: [{ write: {} }] } }));
    const { result, ctx } = await runDiamond(provider);
    expect(result.exitCode).toBe(0);
    const state = await readState(ctx.runDir);
    expect(state.tasks["2"]!.status).toBe("merged");
    expect(state.tasks["2"]!.attempts).toBe(1);
  });

  it("keeps each task's diff and baseSha after its worktree is gone, and a retry shows only the last attempt", async () => {
    const script = fakeScriptSchema.parse({
      "task:2": {
        attempts: [{ write: { "junk-a1.txt": "x" }, commit: true, exitCode: 1 }, { write: { "good-a2.txt": "y" } }],
      },
    });
    const events = new RunEmitter();
    const latest = new Map<string, RunEventMap["nodeChanges"]["changes"]>();
    events.on("nodeChanges", (e) => latest.set(e.nodeId, e.changes));
    const { ctx, tasks, result } = await runDiamond(createFakeProvider(script), 1, { events });
    expect(result.exitCode).toBe(0);
    const state = await readState(ctx.runDir);
    for (const t of tasks) {
      expect(state.tasks[t.id]!.baseSha).toBeTruthy();
    }
    await new Promise((r) => setTimeout(r, 100));
    for (const t of tasks) expect(latest.get(t.id)?.files.length ?? 0).toBeGreaterThan(0);
    const paths = latest.get("2")!.files.map((f) => f.path);
    expect(paths).toContain("good-a2.txt");
    expect(paths).not.toContain("junk-a1.txt");
  });

  it("tells a retry why the previous attempt failed", async () => {
    const provider = createFakeProvider(fakeScriptSchema.parse({ "task:2": { attempts: [{ commit: false, write: {} }, {}] } }));
    const { result } = await runDiamond(provider);
    expect(result.exitCode).toBe(0);
    const calls = provider.calls.filter((c) => c.label === "2");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("A previous attempt at this task failed: the agent made no commit.");
    expect(calls[1]!.prompt).toContain("finish with the empty commit");
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

  it("stops a task agent stuck repeating one tool call and restarts it with the reason", async () => {
    const provider = createFakeProvider(fakeScriptSchema.parse({ "task:2": { attempts: [{ loop: 8 }] } }));
    const { ctx, result } = await runDiamond(provider);
    expect(result.exitCode).toBe(0);

    const state = await readState(ctx.runDir);
    expect(state.tasks["2"]).toMatchObject({ status: "merged", attempts: 2 });
    const [first, second] = provider.calls.filter((c) => c.label === "2");
    expect(first!.signal.aborted).toBe(true);
    expect(path.basename(second!.cwd)).toBe("task-2-a2");
    expect(second!.prompt).toContain("A previous attempt at this task failed: the agent was stopped because it made the same tool call 5 times in a row");
    expect(lines).toContain(
      '[2] stopped: it made the same tool call 5 times in a row: Bash {"command":"npm test","description":"Run the tests (5)"}; retrying',
    );
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
    expect(provider.calls.map((c) => c.label)).toEqual(["1", "2", "2", "2", "summary-2"]);
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
        return { log, stop: async () => void seen.push("stop") };
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
      ui: () => ({ log, stop: async () => void lines.push("<ui stopped>") }),
    });
    expect(result.exitCode).toBe(2);
    const stopped = lines.indexOf("<ui stopped>");
    const aborted = lines.findIndex((l) => l.startsWith("aborted at task 1"));
    expect(stopped).toBeGreaterThan(-1);
    expect(aborted).toBeGreaterThan(stopped);
  });

  it("counts an attempt without a commit as a failure", async () => {
    const script = fakeScriptSchema.parse({ "task:1": { attempts: [{ commit: false, write: {} }] } });
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
    await runDiamond(createFakeProvider(), undefined, { merge: false });
    await runDiamond(createFakeProvider(), undefined, { merge: false });
    const exclude = await readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".graph-execution/")).toHaveLength(1);
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
  });
});

describe("keepRuns", () => {
  it("deletes applied runs beyond keepRuns at run start", async () => {
    await writeFile(path.join(repo, "graph-execution.config.json"), JSON.stringify({ keepRuns: 2 }));
    await gitOut(repo, ["add", "-A"]);
    await gitOut(repo, ["commit", "-q", "-m", "config"]);
    for (let i = 0; i < 4; i++) {
      await runDiamond();
      await gitOut(repo, ["add", "-A"]);
      await gitOut(repo, ["commit", "-q", "--allow-empty", "-m", "x"]);
    }
    const runs = await readdir(path.join(repo, ".graph-execution"));
    expect(runs).toHaveLength(3);
    expect(await gitOut(repo, ["branch", "--list", "graph-task/*"])).toBe("");
    expect((await gitOut(repo, ["branch", "--list", "graph/*"])).split("\n").filter(Boolean)).toHaveLength(3);
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

  it("does not warn about an uncommitted spec and task folder: the agents get copies", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(repo, ".agents", "tasks"), { recursive: true });
    await writeFile(path.join(repo, ".agents", "tasks", "1.json"), "{}");
    await writeFile(path.join(repo, "PRD.md"), "# spec\n");
    await startup({ cwd: repo, provider: "fake", providerInstance: createFakeProvider(), references: ["PRD.md", ".agents/tasks"], log });
    expect(lines.some((l) => l.includes("uncommitted changes"))).toBe(false);
    await writeFile(path.join(repo, "other.txt"), "x\n");
    await startup({ cwd: repo, provider: "fake", providerInstance: createFakeProvider(), references: ["PRD.md", ".agents/tasks"], log });
    expect(lines.some((l) => l.includes("uncommitted changes"))).toBe(true);
  });

  it("refuses to start outside a git repository", async () => {
    await expect(startup({ cwd: tmpdir(), provider: "fake", log })).rejects.toThrow(/not inside a git repository/);
  });
});
