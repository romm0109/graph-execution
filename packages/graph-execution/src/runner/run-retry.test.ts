import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { Provider } from "../providers/types.js";
import { LOCK_FILE } from "../state/state.js";
import { RunEmitter, type RunEventMap } from "./events.js";
import { RetryHub } from "./retry-hub.js";
import { run } from "./run.js";
import { RunStore } from "../ui/store.js";
import { startup } from "./startup.js";
import { fixture, spec, repo, lines, log, readState, runDiamond, onReview } from "../__fixtures__/run-diamond.js";

describe("retrying in the same process", () => {
  const fail = { commit: false, write: {} };
  const failing = (key: string, times = 3) =>
    createFakeProvider(fakeScriptSchema.parse({ [key]: { attempts: Array.from({ length: times }, () => fail) } }));

  async function start(provider: Provider, extra: { signal?: AbortSignal; ui?: boolean } = {}) {
    const hub = new RetryHub();
    const events = new RunEmitter();
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
    let view: RunStore | undefined;
    const seen: string[] = [];
    for (const type of ["run:restart", "retry:available", "run:end"] as const) events.on(type, () => seen.push(type));
    const done = run(ctx, tasks, {
      specPath: spec,
      tasksDir: fixture("diamond"),
      log,
      concurrency: 1,
      events,
      retry: hub,
      signal: extra.signal,
      ui: async (o) => {
        view = o.store;
        return { log, stop: async () => void lines.push("ui stopped") };
      },
    });
    return { hub, ctx, done, seen, view: () => view! };
  }

  it("re-runs a failed task in the same process", async () => {
    const provider = failing("task:2");
    const { hub, ctx, done, seen, view } = await start(provider);
    expect(await hub.whenWaiting()).toContain("2");
    expect((await readState(ctx.runDir)).tasks["2"]!.status).toBe("failed");
    expect(view().getState().summary).toBeDefined();
    expect(view().getState().retryable).toContain("2");
    expect(existsSync(path.join(ctx.runDir, LOCK_FILE))).toBe(true);
    expect(hub.retryNode("2")).toEqual({ ok: true });
    const result = await done;
    expect(result.exitCode).toBe(0);
    expect((await readState(ctx.runDir)).tasks["2"]!.status).toBe("merged");
    expect(provider.calls.filter((c) => c.role === "task" && c.label === "2")).toHaveLength(4);
    expect(seen.filter((e) => e === "run:restart")).toHaveLength(1);
    expect(seen.filter((e) => e === "run:end")).toHaveLength(2);
    expect(view().getState().retryable).toEqual([]);
    expect(hub.retryNode("2")).toEqual({ ok: false, reason: "not_waiting" });
  });

  it("returns the aborted result on quit, with the run resumable and the abort message after the UI stopped", async () => {
    const { hub, ctx, done } = await start(failing("task:2"));
    await hub.whenWaiting();
    expect(hub.retryNode("nope")).toEqual({ ok: false, reason: "not_retryable" });
    hub.quit();
    const result = await done;
    expect(result.exitCode).toBe(2);
    expect((await readState(ctx.runDir)).tasks["2"]!.status).toBe("failed");
    expect(existsSync(path.join(ctx.runDir, LOCK_FILE))).toBe(false);
    expect(lines.indexOf("ui stopped")).toBeLessThan(lines.findIndex((l) => l.startsWith("aborted at task 2")));
  });

  it("merges what was done so far into the starting branch instead of retrying", async () => {
    const { hub, ctx, done, view } = await start(failing("task:2"));
    await hub.whenWaiting();
    expect(hub.mergeable).toBe(true);
    expect(view().getState().mergeable).toBe(true);
    expect(hub.mergeNow()).toEqual({ ok: true });
    const result = await done;
    expect(result.exitCode).toBe(2);
    const { summary } = view().getState();
    expect(summary?.merge).toMatchObject({ target: "main", ok: true });
    expect(summary!.merge!.files.map((f) => f.path)).toEqual(["1.txt"]);
    expect(existsSync(path.join(repo, "1.txt"))).toBe(true);
    expect(existsSync(path.join(repo, "2.txt"))).toBe(false);
    expect(view().getState().mergeable).toBe(false);
    expect((await readState(ctx.runDir)).tasks["2"]!.status).toBe("failed");
    expect(hub.mergeNow()).toEqual({ ok: false, reason: "not_waiting" });
  });

  it("does not offer a merge with --no-merge", async () => {
    const hub = new RetryHub();
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: failing("task:2"), log });
    const done = run(ctx, tasks, { specPath: spec, tasksDir: fixture("diamond"), log, concurrency: 1, retry: hub, merge: false });
    await hub.whenWaiting();
    expect(hub.mergeNow()).toEqual({ ok: false, reason: "not_mergeable" });
    hub.quit();
    expect((await done).exitCode).toBe(2);
  });

  it("never offers a deliberate interrupt", async () => {
    const controller = new AbortController();
    const provider = createFakeProvider(
      fakeScriptSchema.parse({ "task:2": { attempts: [{ hang: true, exitCode: 1 }] } }),
      { onSpawn: () => controller.abort() },
    );
    const { hub, done } = await start(provider, { signal: controller.signal });
    expect((await done).exitCode).toBe(2);
    expect(hub.retryable).toEqual([]);
  });

  it("retries a tester that gave up", async () => {
    const provider = createFakeProvider(
      fakeScriptSchema.parse({ "tester:tester-r0": { attempts: [1, 2, 3].map(() => ({ report: "not json" })) } }),
    );
    const switched = onReview(provider, () => gitOut(repo, ["switch", "-q", "-c", "elsewhere"]));
    const { hub, ctx, done } = await start(switched);
    const nodes = await hub.whenWaiting();
    expect(nodes).toContain("@tester");
    await gitOut(repo, ["switch", "-q", "main"]);
    hub.retryNode("@tester");
    const result = await done;
    expect(result.exitCode).toBe(0);
    expect(provider.calls.filter((c) => c.role === "tester").length).toBe(4);
    const report = JSON.parse(await readFile(path.join(ctx.runDir, "reports", "round0", "tester.json"), "utf8"));
    expect(JSON.stringify(report.notes ?? [])).not.toContain("not performed");
  });

  it("does not offer a tester that gave up once the result was applied", async () => {
    const provider = createFakeProvider(
      fakeScriptSchema.parse({ "tester:tester-r0": { attempts: [1, 2, 3].map(() => ({ report: "not json" })) } }),
    );
    const { hub, done } = await start(provider);
    expect((await done).exitCode).toBe(0);
    expect(hub.retryable).toEqual([]);
  });

  it("retries a fixer that ran out of attempts", async () => {
    const blocker = {
      id: "F1",
      severity: "blocker",
      file: "1.txt",
      line: 1,
      description: "Wrong content.",
      failureScenario: "Reading 1.txt returns the task id instead of the result.",
      status: "open",
    };
    const provider = createFakeProvider(
      fakeScriptSchema.parse({
        "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
        "fixer:fix-r1": { attempts: [fail, fail, fail] },
      }),
    );
    const { hub, ctx, done } = await start(provider);
    expect(await hub.whenWaiting()).toContain("@fixer");
    expect((await readState(ctx.runDir)).review.phase).toBe("fix");
    hub.retryNode("@fixer");
    expect((await done).exitCode).toBe(0);
  });
});

describe("run status", () => {
  const branches = (): Promise<string> => gitOut(repo, ["branch", "--list", "graph-task/*"]);

  it("ends applied and deletes the task branches, keeping the integration branch", async () => {
    const { ctx } = await runDiamond();
    expect((await readState(ctx.runDir)).status).toBe("applied");
    expect(await branches()).toBe("");
    expect(await gitOut(repo, ["branch", "--list", `graph/${ctx.runId}`])).toContain(ctx.runId);
  });

  it("ends done without --merge and deletes the task branches", async () => {
    const { ctx } = await runDiamond(createFakeProvider(), undefined, { merge: false });
    expect((await readState(ctx.runDir)).status).toBe("done");
    expect(await branches()).toBe("");
  });

  it("ends failed with its task branches when the review is exhausted", async () => {
    await writeFile(path.join(repo, "graph-execution.config.json"), JSON.stringify({ fixPasses: 0 }));
    const blocker = {
      id: "F1",
      severity: "blocker",
      file: "1.txt",
      line: 1,
      description: "Wrong content.",
      failureScenario: "Reading 1.txt returns the task id instead of the result.",
      status: "open",
    };
    const provider = createFakeProvider(
      fakeScriptSchema.parse({ "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] } }),
    );
    const { ctx, result } = await runDiamond(provider);
    expect(result.exitCode).toBe(1);
    expect((await readState(ctx.runDir)).status).toBe("failed");
    expect(await branches()).not.toBe("");
  });

  it("ends aborted when interrupted", async () => {
    const controller = new AbortController();
    const script = fakeScriptSchema.parse({ "task:2": { attempts: [{ hang: true }] } });
    const provider = createFakeProvider(script, { onSpawn: () => controller.abort() });
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
    await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, signal: controller.signal, concurrency: 1 });
    expect((await readState(ctx.runDir)).status).toBe("aborted");
    expect(await branches()).not.toBe("");
  });
});

describe("failure summaries", () => {
  const crash = { exitCode: 1, commit: false };
  const good = { cause: "the agent crashed", verdict: "likely_to_work", why: "it looks transient" };
  const infos = (events: RunEmitter) => {
    const out: RunEventMap["failure:info"][] = [];
    events.on("failure:info", (info) => out.push(info));
    return out;
  };
  const summarizerCalls = (provider: { calls: { role: string }[] }) => provider.calls.filter((c) => c.role === "summarizer");

  it("summarizes a failed task once, with the run's provider", async () => {
    const provider = createFakeProvider(
      fakeScriptSchema.parse({
        "task:2": { attempts: [crash, crash, crash] },
        "summarizer:summary-2": { attempts: [{ summary: good }] },
      }),
    );
    const events = new RunEmitter();
    const seen = infos(events);
    const { result } = await runDiamond(provider, 1, { events });
    expect(result.exitCode).toBe(2);
    expect(summarizerCalls(provider)).toHaveLength(1);
    expect(seen.map((i) => i.summary.status)).toEqual(["pending", "ready"]);
    expect(seen[1]).toMatchObject({ nodeId: "2", summary: good });
    expect(lines.some((l) => l.startsWith("task 2 failed: the agent crashed"))).toBe(true);
  });

  it("yields unavailable when the summary call throws, and the run ends as usual", async () => {
    const provider = createFakeProvider(
      fakeScriptSchema.parse({
        "task:2": { attempts: [crash, crash, crash] },
        "summarizer:summary-2": { attempts: [{ throw: "no provider" }] },
      }),
    );
    const events = new RunEmitter();
    const seen = infos(events);
    const { result } = await runDiamond(provider, 1, { events });
    expect(result.exitCode).toBe(2);
    expect(seen.at(-1)!.summary.status).toBe("unavailable");
    expect(lines).toContain("could not summarize the failure of task 2");
    expect(lines.some((l) => l.startsWith("aborted at task 2"))).toBe(true);
  });

  it("makes no summary call for an external abort", async () => {
    const controller = new AbortController();
    const provider = createFakeProvider(fakeScriptSchema.parse({ "task:2": { attempts: [{ hang: true }] } }), {
      onSpawn: () => controller.abort(),
    });
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
    const result = await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, signal: controller.signal, concurrency: 1 });
    expect(result.exitCode).toBe(2);
    expect(summarizerCalls(provider)).toHaveLength(0);
  });

  it("summarizes a reviewer that gave up while the run continues", async () => {
    const provider = createFakeProvider(
      fakeScriptSchema.parse({
        "reviewer:code-r0": { attempts: [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }] },
        "summarizer:summary--reviewer": { attempts: [{ summary: good }] },
      }),
    );
    const events = new RunEmitter();
    const seen = infos(events);
    const { result } = await runDiamond(provider, undefined, { events });
    expect(result.exitCode).toBe(0);
    expect(seen.filter((i) => i.nodeId === "@reviewer").at(-1)?.summary).toMatchObject({ status: "ready" });
  });
});
