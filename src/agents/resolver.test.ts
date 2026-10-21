import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, type FakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { AgentRun, AgentRunOptions, Provider } from "../providers/types.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import { stateSchema } from "../state/state.js";
import { resolverPrompt } from "./resolver.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
const spec = fixture("spec.md");

let repo: string;
let tasksDir: string;
let lines: string[];
const log = (line: string): void => {
  lines.push(line);
};

beforeEach(async () => {
  repo = await tempRepo();
  tasksDir = await mkdtemp(path.join(tmpdir(), "graph-execution-tasks-"));
  lines = [];
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(tasksDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const RESOLVED = "base\ntwo\nthree\n";
const MARKERS = "<<<<<<< HEAD\ntwo\n=======\nthree\n>>>>>>> graph-task\n";

/** Task 1 creates `shared.txt`; tasks 2 and 3 (and 4 when given) depend on it; 2 and 3 rewrite the same line. */
async function conflictingRun(
  script: Record<string, unknown>,
  opts: { provider?: (p: Provider) => Provider; withTask4?: boolean } = {},
) {
  const ids = opts.withTask4 ? ["1", "2", "3", "4"] : ["1", "2", "3"];
  for (const id of ids) {
    const dependencies = id === "1" ? [] : ["1"];
    await writeFile(path.join(tasksDir, `${id}.json`), JSON.stringify({ id, content: `Task ${id}.`, dependencies }));
  }
  const fake = createFakeProvider(
    fakeScriptSchema.parse({
      "task:1": { attempts: [{ write: { "shared.txt": "base\n" } }] },
      "task:2": { attempts: [{ write: { "shared.txt": "base\ntwo\n" } }] },
      "task:3": { attempts: [{ write: { "shared.txt": "base\nthree\n" } }] },
      ...script,
    }),
  );
  // Task 3's worktree must be cut before task 2 merges, and its agent may only commit after: its merge then
  // conflicts. Task 2 waits until task 3 has started (its worktree exists), task 3 until task 2 has merged.
  let task3Started!: () => void;
  const task3 = new Promise<void>((resolve) => (task3Started = resolve));
  const ordered = hooked(fake, {
    "task:2": () => task3,
    "task:3": (run) => {
      task3Started();
      return waitForMerge(run.cwd, "Merge task 2");
    },
  });
  const provider = opts.provider?.(ordered) ?? ordered;
  const tasks = await loadTasks(tasksDir);
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
  const result = await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, concurrency: 3 });
  const integration = path.join(ctx.runDir, "worktrees", "integration");
  return { ctx, result, fake, integration, branch: `graph/${ctx.runId}` };
}

const resolverCalls = (fake: FakeProvider): AgentRunOptions[] => fake.calls.filter((c) => c.role === "resolver");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once a commit with `subject` is on the integration branch, seen from any worktree of the repo. */
async function waitForMerge(cwd: string, subject: string): Promise<void> {
  const branch = await gitOut(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/graph/"]);
  while (!(await gitOut(cwd, ["log", "--format=%s", branch])).split("\n").includes(subject)) await sleep(20);
}

const merging = async (cwd: string): Promise<boolean> =>
  (await execa("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd, reject: false })).exitCode === 0;

/** A merge stopped on conflicts in `cwd`: in progress, with unmerged paths (not just any merge being written). */
const conflicted = async (cwd: string): Promise<boolean> =>
  (await merging(cwd)) && (await gitOut(cwd, ["diff", "--name-only", "--diff-filter=U"])) !== "";

/** Runs the hook for the matching `<role>:<label>` before the inner agent run starts. */
function hooked(inner: Provider, hooks: Record<string, (opts: AgentRunOptions) => Promise<void>>): Provider {
  return {
    name: inner.name,
    run(opts): AgentRun {
      const hook = hooks[`${opts.role}:${opts.label}`];
      if (!hook) return inner.run(opts);
      const started = hook(opts).then(() => inner.run(opts));
      return {
        events: (async function* () {
          yield* (await started).events;
        })(),
        done: started.then((r) => r.done),
      };
    },
  };
}

describe("resolverPrompt specs", () => {
  it("adds a section with each feature name and text only when specs are given", () => {
    const specs = [
      { name: "auth", path: "/p/auth.md", text: "AUTH-TEXT" },
      { name: "export", path: "/p/export.md", text: "EXPORT-TEXT" },
    ];
    const prompt = resolverPrompt("b", ["x.txt"], specs);
    expect(prompt).toContain("## What each side is for");
    expect(prompt).toContain("### Feature auth (`/p/auth.md`)\n\nAUTH-TEXT");
    expect(prompt).toContain("### Feature export (`/p/export.md`)\n\nEXPORT-TEXT");
    expect(prompt.indexOf("What each side is for")).toBeLessThan(prompt.indexOf("Resolve every conflict"));
    expect(resolverPrompt("b", ["x.txt"])).not.toContain("What each side is for");
  });
});

describe("merge resolver", () => {
  it("resolves two tasks that edit the same line and records the merge commit", async () => {
    const { ctx, result, fake, branch } = await conflictingRun({
      "resolver:3": { attempts: [{ write: { "shared.txt": RESOLVED } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(await gitOut(repo, ["show", `${branch}:shared.txt`])).toBe(RESOLVED.trimEnd());

    const calls = resolverCalls(fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(path.join(ctx.runDir, "worktrees", "integration"));
    expect(calls[0]!.prompt).toBe(resolverPrompt(`graph-task/${ctx.runId}/3`, ["shared.txt"]));
    expect(calls[0]!.prompt).toContain("git commit --no-edit");

    const state = stateSchema.parse(JSON.parse(await readFile(path.join(ctx.runDir, "state.json"), "utf8")));
    expect(state.tasks["3"]!.status).toBe("merged");
    expect(state.tasks["3"]!.mergeCommit).toBe(await gitOut(repo, ["rev-parse", branch]));
    // The task branch is deleted once the run succeeds: the merge's second parent is task 3's own commit.
    expect(await gitOut(repo, ["log", "-1", "--format=%s", `${branch}^2`])).toBe("fake: task:3 attempt 1");
    // A successful run removes every worktree, the integration one included.
    expect(await readdir(ctx.runDir)).not.toContain("worktrees");
  });

  it("accepts fix-up commits the resolver makes on top of the merge commit", async () => {
    // After completing the merge, the resolver commits a follow-up fix, as for a duplicate a clean auto-merge left.
    const fixup = (inner: Provider): Provider => ({
      name: inner.name,
      run(opts): AgentRun {
        const agent = inner.run(opts);
        if (opts.role !== "resolver") return agent;
        return {
          events: agent.events,
          done: agent.done.then(async (r) => {
            await writeFile(path.join(opts.cwd, "fixup.txt"), "fixed\n");
            await execa("git", ["add", "fixup.txt"], { cwd: opts.cwd });
            await execa("git", ["commit", "-m", "Fix after merge"], { cwd: opts.cwd });
            return r;
          }),
        };
      },
    });
    const { result, fake, branch } = await conflictingRun(
      { "resolver:3": { attempts: [{ write: { "shared.txt": RESOLVED } }] } },
      { provider: fixup },
    );
    expect(result.exitCode).toBe(0);
    expect(resolverCalls(fake)).toHaveLength(1);
    expect(await gitOut(repo, ["show", `${branch}:fixup.txt`])).toBe("fixed");
    expect(await gitOut(repo, ["log", "-1", "--format=%s", `${branch}~1^2`])).toBe("fake: task:3 attempt 1");
  });

  it("retries a resolver that leaves conflict markers, unmerged paths or no merge commit", async () => {
    const { result, fake, branch } = await conflictingRun({
      "resolver:3": {
        attempts: [
          // Commits the markers: the merge commit exists but is rejected, and must not survive.
          { write: { "shared.txt": MARKERS } },
          // Resolves the file but never stages it: unmerged paths remain.
          { write: { "shared.txt": RESOLVED }, commit: false },
          { write: { "shared.txt": RESOLVED } },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(resolverCalls(fake)).toHaveLength(3);
    expect(await gitOut(repo, ["show", `${branch}:shared.txt`])).toBe(RESOLVED.trimEnd());
    expect(await gitOut(repo, ["log", "--format=%s", branch])).not.toContain("resolver:3 attempt 1");
    expect(lines).toContain("task 3: resolver conflict markers left in shared.txt; retry 2/3");
    expect(lines).toContain("task 3: resolver unmerged paths left: shared.txt; retry 3/3");
  });

  it("aborts with exit code 2 after three failed attempts, keeping state and the conflicted worktree", async () => {
    const marked = { write: { "shared.txt": MARKERS } };
    const { ctx, result, fake, integration, branch } = await conflictingRun({
      "resolver:3": { attempts: [marked, { exitCode: 1, commit: false }, marked] },
    });
    expect(result.exitCode).toBe(2);
    expect(resolverCalls(fake)).toHaveLength(3);

    const state = stateSchema.parse(JSON.parse(await readFile(path.join(ctx.runDir, "state.json"), "utf8")));
    expect(state.tasks["2"]!.status).toBe("merged");
    expect(state.tasks["3"]!.status).toBe("failed");
    expect(state.tasks["3"]!.mergeCommit).toBeUndefined();
    // The integration branch still ends at task 2's merge; its worktree is left mid-merge with the conflict.
    expect(await gitOut(repo, ["rev-parse", branch])).toBe(state.tasks["2"]!.mergeCommit);
    expect(await gitOut(integration, ["diff", "--name-only", "--diff-filter=U"])).toBe("shared.txt");
    expect((await readdir(path.join(ctx.runDir, "worktrees"))).sort()).toEqual(["integration", "task-3-a1"]);
    expect(lines.some((l) => l.startsWith("aborted at task 3 merge resolver: task 3 merge resolver failed after 3"))).toBe(
      true,
    );
  });

  it("never invokes the resolver without conflicts", async () => {
    const fake = createFakeProvider();
    const tasks = await loadTasks(fixture("diamond"));
    const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: fake, log });
    const result = await run(ctx, tasks, { specPath: spec, tasksDir: "tasks", log, concurrency: 3 });
    expect(result.exitCode).toBe(0);
    expect(resolverCalls(fake)).toHaveLength(0);
  });

  it("holds the merge lock for the whole resolution", async () => {
    let duringResolution: { headMoved: boolean; merging: boolean } | undefined;
    const { result, branch } = await conflictingRun(
      { "resolver:3": { attempts: [{ write: { "shared.txt": RESOLVED } }] } },
      {
        withTask4: true,
        provider: (inner) =>
          hooked(inner, {
            // Task 4 commits only once the conflicted merge of task 3 is in progress.
            "task:4": async (run) => {
              const integration = path.join(path.dirname(run.cwd), "integration");
              while (!(await conflicted(integration))) await sleep(20);
            },
            // Once task 4 committed it is ready to merge; it must wait for the lock until the resolver is done.
            "resolver:3": async (opts) => {
              const head = await gitOut(opts.cwd, ["rev-parse", "HEAD"]);
              const runId = (await gitOut(opts.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).replace(/^graph\//, "");
              while (!(await gitOut(repo, ["log", "--format=%s", `graph-task/${runId}/4`])).includes("fake: task:4")) {
                await sleep(20);
              }
              await sleep(300);
              duringResolution = {
                headMoved: head !== (await gitOut(opts.cwd, ["rev-parse", "HEAD"])),
                merging: await merging(opts.cwd),
              };
            },
          }),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(duringResolution).toEqual({ headMoved: false, merging: true });
    const merges = (await gitOut(repo, ["log", "--first-parent", "--format=%s", branch])).split("\n").reverse();
    expect(merges).toEqual(["initial", "Merge task 1", "Merge task 2", "fake: resolver:3 attempt 1", "Merge task 4"]);
  });
});
