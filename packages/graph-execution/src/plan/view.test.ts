import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunState } from "../state/state.js";
import { SANDBOX_ENV } from "../state/paths.js";
import { integrationWorktreeOf } from "./paths.js";
import { PLAN_SPEC_MAX_CHARS, planView, taskTitle } from "./view.js";

const dirs: string[] = [];
afterEach(async () => {
  delete process.env[SANDBOX_ENV];
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const stateOf = (over: Omit<Partial<RunState>, "plan"> & { plan?: Partial<NonNullable<RunState["plan"]>> }): RunState =>
  ({
    runId: "r1",
    integrationBranch: "graph/r1",
    status: "planning",
    tasks: {},
    ...over,
    plan: { contentPath: "/c.md", refs: [], gate: true, attempts: 1, questions: [], dropped: [], feedback: [], ...over.plan },
  }) as RunState;

async function planned(spec: string): Promise<string> {
  const runDir = await mkdtemp(path.join(tmpdir(), "plan-view-"));
  dirs.push(runDir);
  const wt = integrationWorktreeOf(runDir);
  await mkdir(path.join(wt, "docs", "prd"), { recursive: true });
  await mkdir(path.join(wt, ".agents", "tasks", "p"), { recursive: true });
  await writeFile(path.join(wt, "docs", "prd", "p.md"), spec);
  await writeFile(path.join(wt, ".agents", "tasks", "p", "1.json"), JSON.stringify({ id: "1", content: "# Build one\n\nmore" }));
  await writeFile(path.join(wt, ".agents", "tasks", "p", "2.json"), JSON.stringify({ id: "2", content: "no heading", dependencies: ["1"] }));
  return runDir;
}

describe("planView", () => {
  it("shows a planning round with its refs and the last rejected error", async () => {
    const v = await planView(stateOf({ plan: { attempts: 2, refs: [{ ref: "KAN-1", url: "https://x" }] } }), "/nowhere", {
      attempts: 3,
      lastError: "bad",
    });
    expect(v).toEqual({
      status: "planning",
      attempt: 2,
      attempts: 3,
      refs: [{ ref: "KAN-1", url: "https://x" }],
      lastError: "bad",
      questions: [],
      dropped: [],
      branch: "graph/r1",
    });
  });

  it("reads the planned spec and tasks and gives the approve / replan commands", async () => {
    const runDir = await planned("# Spec\n");
    const v = await planView(stateOf({ status: "awaiting-approval", plan: { name: "p", dropped: ["A"] } }), runDir, { attempts: 3 });
    expect(v.name).toBe("p");
    expect(v.specRel).toBe("docs/prd/p.md");
    expect(v.tasksRel).toBe(".agents/tasks/p");
    expect(v.spec).toBe("# Spec\n");
    expect(v.tasks).toEqual([
      { id: "1", title: "Build one", dependencies: [] },
      { id: "2", title: "2", dependencies: ["1"] },
    ]);
    expect(v.approve).toBe("graph-execution --resume --run r1 --approve-plan");
    expect(v.replan).toBe("graph-execution --resume --run r1 --replan <feedback.md>");
    expect(v.hint).toBeUndefined();
  });

  it("caps the spec and adds --sandbox in a sandbox", async () => {
    process.env[SANDBOX_ENV] = "1";
    const runDir = await planned("x".repeat(PLAN_SPEC_MAX_CHARS + 10));
    const v = await planView(stateOf({ status: "awaiting-approval", plan: { name: "p" } }), runDir, { attempts: 3 });
    expect(v.spec!.startsWith("x".repeat(PLAN_SPEC_MAX_CHARS))).toBe(true);
    expect(v.spec!.length).toBeLessThan(PLAN_SPEC_MAX_CHARS + 20);
    expect(v.approve).toBe("graph-execution --resume --run r1 --approve-plan --sandbox");
    expect(v.hint).toBe("or approve it in graph-manager");
  });

  it("counts a status after the plan stage as running, without commands", async () => {
    const runDir = await planned("# Spec\n");
    const v = await planView(stateOf({ status: "applied", plan: { name: "p" } }), runDir, { attempts: 3 });
    expect(v.status).toBe("running");
    expect(v.approve).toBeUndefined();
  });
});

describe("taskTitle", () => {
  it("is the first # heading, else the id", () => {
    expect(taskTitle({ id: "a", content: "intro\n# Title here\n# Other" })).toBe("Title here");
    expect(taskTitle({ id: "a", content: "## Sub\ntext" })).toBe("a");
  });
});
