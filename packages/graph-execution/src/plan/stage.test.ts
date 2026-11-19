import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { lines, log, readState, repo } from "../__fixtures__/run-diamond.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { resume, runPlanned } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import { EXIT_AWAITING_APPROVAL, EXIT_NEEDS_INFO, EXIT_SUCCESS } from "../state/errors.js";
import { integrationWorktreeOf, planRefsPath } from "./paths.js";

const git = async (...args: string[]): Promise<string> => (await execa("git", args, { cwd: repo })).stdout;

async function plan(gate: boolean, script: Record<string, unknown> = {}, text = "# Build 1.txt\n", refs: string[] = []) {
  const content = path.join(repo, ".git", "c.md");
  await writeFile(content, text);
  const provider = createFakeProvider(fakeScriptSchema.parse(script));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
  const run = runPlanned(ctx, { contentFile: content, gate, log, refs: refs.map((ref) => ({ ref })) });
  return { ctx, run, provider };
}

const bad = JSON.stringify({ id: "1", content: "x", dependencies: ["1"] });
const badAttempt = { write: { ".agents/tasks/fake-plan/1.json": bad } };

describe("runPlanned", () => {
  it("plans, commits the plan and runs it in the same process without the gate", async () => {
    const { ctx, run } = await plan(false);
    const result = await run;
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("applied");
    expect(state.plan?.name).toBe("fake-plan");
    expect(await git("log", "--format=%s", `graph/${ctx.runId}`)).toContain("Plan: fake-plan");
    const files = (await git("ls-tree", "-r", "--name-only", `graph/${ctx.runId}`)).split("\n");
    expect(files).toEqual(expect.arrayContaining(["docs/prd/fake-plan.md", ".agents/tasks/fake-plan/1.json", "1.txt"]));
    expect(lines.some((l) => l.startsWith("planned fake-plan:"))).toBe(true);
  });

  it("stops at awaiting-approval with the gate on", async () => {
    const { ctx, run } = await plan(true);
    const result = await run;
    expect(result.exitCode).toBe(EXIT_AWAITING_APPROVAL);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("awaiting-approval");
    expect(state.plan?.name).toBe("fake-plan");
    expect(state.plan?.attempts).toBe(1);
    expect(state.specPath?.endsWith(path.join("docs", "prd", "fake-plan.md"))).toBe(true);
    expect(state.tasksDir?.endsWith(path.join(".agents", "tasks", "fake-plan"))).toBe(true);
    expect(state.hashes?.tasks).not.toBe("");
    expect(state.tasks).toEqual({ "1": { status: "pending", attempts: 0 } });
    expect(existsSync(integrationWorktreeOf(ctx.runDir))).toBe(true);
    // Nothing lands in the checkout before the run is applied.
    expect(existsSync(path.join(repo, "docs", "prd", "fake-plan.md"))).toBe(false);
  });

  it("picks another name when the repository has a spec of that name", async () => {
    await mkdir(path.join(repo, "docs", "prd"), { recursive: true });
    await writeFile(path.join(repo, "docs", "prd", "fake-plan.md"), "# Old\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "old plan");
    const { ctx, run } = await plan(true);
    await run;
    expect((await readState(ctx.runDir)).plan?.name).toBe("fake-plan-2");
  });

  it("retries the planner with the error and fails the run after planAttempts rounds", async () => {
    const { ctx, run, provider } = await plan(true, { "planner:plan": { attempts: [badAttempt, badAttempt, badAttempt] } });
    await expect(run).rejects.toThrow(/planning failed after 3 attempt\(s\)/);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("failed");
    expect(state.plan?.attempts).toBe(3);
    expect(state.plan?.error).toMatch(/depends on itself/);
    expect(state.specPath).toBeUndefined();
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[0]!.prompt).not.toContain("## Previous attempt");
    expect(provider.calls[1]!.prompt).toContain("## Previous attempt");
    expect(provider.calls[1]!.prompt).toContain("depends on itself");
    expect(lines.some((l) => l.startsWith("planning: attempt 1/3 rejected:"))).toBe(true);
  });

  it("goes on when a later round is valid", async () => {
    const { ctx, run } = await plan(true, { "planner:plan": { attempts: [badAttempt] } });
    expect((await run).exitCode).toBe(EXIT_AWAITING_APPROVAL);
    const state = await readState(ctx.runDir);
    expect(state.plan?.attempts).toBe(2);
    expect(state.plan?.error).toBeUndefined();
    expect(state.status).toBe("awaiting-approval");
  });

  it("fails the run when the planner writes no result", async () => {
    const none = { result: null };
    const { ctx, run } = await plan(true, { "planner:plan": { attempts: [none, none, none] } });
    await expect(run).rejects.toThrow(/wrote no result file/);
    expect((await readState(ctx.runDir)).status).toBe("failed");
  });

  it("ends needs-info when the content is not ready, without a plan commit", async () => {
    const { ctx, run } = await plan(false, {}, "# Build\nNOT-READY\n");
    const result = await run;
    expect(result.exitCode).toBe(EXIT_NEEDS_INFO);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("needs-info");
    expect(state.plan?.questions).toEqual([{ questions: ["What should be built?"] }]);
    expect(state.plan?.dropped).toEqual([]);
    expect(await git("log", "--format=%s", `graph/${ctx.runId}`)).not.toContain("Plan:");
    expect(existsSync(integrationWorktreeOf(ctx.runDir))).toBe(false);
    expect(lines.some((l) => l.startsWith("needs info: 1 question(s)"))).toBe(true);
  });

  it("drops the refs that are not ready and runs the rest", async () => {
    const { ctx, run } = await plan(false, {}, "# Build\nNOT-READY: B\n", ["A", "B"]);
    expect((await run).exitCode).toBe(EXIT_SUCCESS);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("applied");
    expect(state.plan?.refs).toEqual([{ ref: "A" }, { ref: "B" }]);
    expect(state.plan?.dropped).toEqual(["B"]);
    expect(state.plan?.questions).toEqual([{ ref: "B", questions: ["What is missing for B?"] }]);
    expect(JSON.parse(await readFile(planRefsPath(ctx.runDir), "utf8"))).toEqual([{ ref: "A" }, { ref: "B" }]);
    expect(lines.some((l) => l.startsWith("dropped B: not ready"))).toBe(true);
  });

  it("ends needs-info when no ref is ready", async () => {
    const { ctx, run } = await plan(true, {}, "NOT-READY: A\nNOT-READY: B\n", ["A", "B"]);
    expect((await run).exitCode).toBe(EXIT_NEEDS_INFO);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("needs-info");
    expect(state.plan?.dropped).toEqual(["A", "B"]);
    expect(state.plan?.questions).toHaveLength(2);
  });

  it("commits only the plan's files", async () => {
    const { ctx, run } = await plan(true, { "planner:plan": { attempts: [{ write: { "stray.txt": "x\n" } }] } });
    await run;
    const files = (await git("ls-tree", "-r", "--name-only", `graph/${ctx.runId}`)).split("\n");
    expect(files).not.toContain("stray.txt");
    expect(files).toContain("docs/prd/fake-plan.md");
    expect(existsSync(path.join(integrationWorktreeOf(ctx.runDir), "stray.txt"))).toBe(false);
  });

  it("plans a run killed while planning again on resume, keeping plan.feedback", async () => {
    const { ctx, run } = await plan(true);
    expect((await run).exitCode).toBe(EXIT_AWAITING_APPROVAL);
    // What a process killed during a re-plan leaves: status planning, no plan yet, the feedback kept, stray files.
    const file = path.join(ctx.runDir, "state.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(path.join(integrationWorktreeOf(ctx.runDir), "stray.txt"), "x\n");
    await git("-C", integrationWorktreeOf(ctx.runDir), "reset", "-q", "--hard", saved.startingCommit);
    delete saved.specPath;
    delete saved.tasksDir;
    delete saved.hashes;
    delete saved.plan.name;
    saved.tasks = {};
    saved.status = "planning";
    saved.plan.feedback = ["Split it in two"];
    await writeFile(file, JSON.stringify(saved));

    const provider = createFakeProvider();
    const result = await resume({ cwd: repo, runId: ctx.runId, providerInstance: provider, log });
    expect(result.exitCode).toBe(EXIT_AWAITING_APPROVAL);
    const state = await readState(ctx.runDir);
    expect(state.status).toBe("awaiting-approval");
    expect(state.plan?.name).toBe("fake-plan");
    expect(state.plan?.feedback).toEqual(["Split it in two"]);
    expect(state.plan?.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.prompt).toContain("Split it in two");
    expect(provider.calls[0]!.prompt).not.toContain("git show");
    expect((await git("log", "--format=%s", `graph/${ctx.runId}`)).split("\n").filter((l) => l === "Plan: fake-plan")).toHaveLength(1);
    expect(existsSync(path.join(integrationWorktreeOf(ctx.runDir), "stray.txt"))).toBe(false);
    expect(lines).toContain(`planning run ${ctx.runId} again from the start`);
  });

  it("replans with feedback on resume and then runs the approved plan", async () => {
    const { ctx, run } = await plan(true);
    expect((await run).exitCode).toBe(EXIT_AWAITING_APPROVAL);
    const rejected = (await git("rev-parse", `graph/${ctx.runId}`)).trim();
    const fb = path.join(repo, ".git", "fb.md");
    await writeFile(fb, "Split it in two\n");
    const provider = createFakeProvider();
    const again = await resume({ cwd: repo, runId: ctx.runId, providerInstance: provider, log, replan: fb });
    expect(again.exitCode).toBe(EXIT_AWAITING_APPROVAL);
    let state = await readState(ctx.runDir);
    expect(state.plan?.feedback).toEqual(["Split it in two"]);
    expect(provider.calls[0]!.prompt).toContain(`git show ${rejected}`);
    // The rejected commit is gone: one plan commit, right on the starting commit (it may get the same sha again).
    expect((await git("log", "--format=%s", `graph/${ctx.runId}`)).split("\n").filter((l) => l.startsWith("Plan:"))).toEqual([
      "Plan: fake-plan",
    ]);
    expect((await git("rev-parse", `graph/${ctx.runId}~1`)).trim()).toBe(state.startingCommit);

    const approved = await resume({ cwd: repo, runId: ctx.runId, providerInstance: createFakeProvider(), log, approvePlan: true });
    expect(approved.exitCode).toBe(EXIT_SUCCESS);
    state = await readState(ctx.runDir);
    expect(state.status).toBe("applied");
    expect(lines).toContain("plan fake-plan approved");
  });
});
