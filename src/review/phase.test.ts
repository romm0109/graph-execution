import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { fixerSummaryPath } from "../agents/fixer.js";
import { codeReportPath } from "../agents/reviewer.js";
import { testerReportPath } from "../agents/tester.js";
import { CONFIG_FILE } from "../config/config.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, type FakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { AgentRun, Provider } from "../providers/types.js";
import { phaseLabel, RunEmitter, type RunEnd } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import { allComments, commentOutcomes, HumanReviewStore, openComments, readFixerNotes } from "./human.js";
import { reportSchema } from "./report.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
const spec = fixture("spec.md");
const tasksDir = fixture("diamond");

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
  await rm(repo, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

const blocker = {
  id: "F1",
  severity: "blocker",
  file: "1.txt",
  line: 1,
  description: "Wrong content.",
  failureScenario: "Reading 1.txt returns the task id instead of the result.",
  status: "open",
};

async function runReview(
  script: unknown = {},
  opts: {
    config?: unknown;
    wrap?: (p: Provider) => Provider;
    noTaskValidation?: boolean;
    events?: RunEmitter;
    tasksDir?: string;
    retry?: RetryHub;
  } = {},
) {
  if (opts.config !== undefined) await writeFile(path.join(repo, CONFIG_FILE), JSON.stringify(opts.config));
  const provider = createFakeProvider(fakeScriptSchema.parse(script));
  const instance = opts.wrap ? opts.wrap(provider) : provider;
  const ctx = await startup({
    cwd: repo,
    provider: "fake",
    providerInstance: instance,
    log,
  });
  const dir = opts.tasksDir ?? tasksDir;
  const loaded = await loadTasks(dir);
  const tasks = opts.noTaskValidation ? loaded.map((t) => ({ ...t, validate: false as const })) : loaded;
  const result = await run(ctx, tasks, {
    specPath: spec,
    tasksDir: dir,
    log,
    concurrency: 1,
    events: opts.events,
    ...(opts.retry ? { retry: opts.retry } : {}),
  });
  const reviewerCalls = provider.calls.filter((c) => c.role === "reviewer");
  const testerCalls = provider.calls.filter((c) => c.role === "tester");
  const reportFile = codeReportPath(ctx.runDir, 0);
  const testerFile = testerReportPath(ctx.runDir, 0);
  return {
    provider,
    ctx,
    result,
    reviewerCalls,
    testerCalls,
    reportFile,
    testerFile,
  };
}

describe("review phase", () => {
  it("writes a valid round 0 code report after all tasks merge and exits 0 without findings", async () => {
    const { ctx, result, reviewerCalls, reportFile } = await runReview();
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(1);
    expect(reportFile).toBe(path.join(ctx.runDir, "reports", "round0", "code.json"));
    const report = reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8")));
    expect(report).toMatchObject({ round: 0, reviewer: "code", findings: [] });
    expect(lines).toContain("code review round 0: 0 blocker, 0 major, 0 minor");
  });

  it("gives the reviewer the spec, the tasks folder, the diff against the starting commit and REVIEW.md", async () => {
    // Uncommitted on purpose: the tool reads it from the repo root, not from the throwaway worktree.
    await writeFile(path.join(repo, "REVIEW.md"), "Rule: every file ends with a newline.\n");
    const { ctx, reviewerCalls, result } = await runReview();
    expect(result.exitCode).toBe(0);
    const call = reviewerCalls[0]!;
    expect(call.prompt).toContain((await readFile(spec, "utf8")).trim());
    expect(call.prompt).toContain(tasksDir);
    const diff = await gitOut(repo, ["diff", `${ctx.startingCommit}..graph/${ctx.runId}`]);
    expect(diff).toContain("+++ b/4.txt");
    expect(call.prompt).toContain(diff);
    expect(call.prompt).toContain("Rule: every file ends with a newline.");
    expect(call.prompt).toContain(codeReportPath(ctx.runDir, 0));
    expect(call.prompt).toMatch(/must not modify|Do NOT modify/);
    expect(call.prompt).toContain("failureScenario");
    expect(path.basename(call.cwd)).toBe("review-code-r0");
  });

  it("runs fine without REVIEW.md", async () => {
    const { result, reviewerCalls } = await runReview();
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls[0]!.prompt).not.toContain("REVIEW.md)");
    expect(lines.some((l) => l.includes("no REVIEW.md"))).toBe(true);
    expect(lines.some((l) => l.startsWith("aborted"))).toBe(false);
  });

  it("retries an invalid or missing report and accepts the third attempt", async () => {
    const { result, reviewerCalls, reportFile } = await runReview({
      "reviewer:code-r0": {
        attempts: [{ report: "{ not json" }, { report: null }, {}],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(3);
    expect(lines.some((l) => l.includes("the report is not valid JSON") && l.includes("retry 2/3"))).toBe(true);
    expect(lines.some((l) => l.includes("no report was written") && l.includes("retry 3/3"))).toBe(true);
    expect(reportSchema.safeParse(JSON.parse(await readFile(reportFile, "utf8"))).success).toBe(true);
  });

  it("continues with a 'code review not performed' note after three invalid reports", async () => {
    const { result, reviewerCalls, reportFile } = await runReview({
      "reviewer:code-r0": {
        attempts: [{ report: { findings: "none" } }, { report: { round: 7 } }, { exitCode: 1 }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(3);
    expect(lines.some((l) => l.includes("does not match the schema"))).toBe(true);
    expect(lines.some((l) => l.includes("must have round 0"))).toBe(true);
    expect(lines.some((l) => l.startsWith("aborted"))).toBe(false);
    const report = reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8")));
    expect(report.findings).toEqual([]);
    expect(report.notes?.[0]).toMatch(/^code review not performed: code review round 0 failed after 3 attempts/);
  });

  it("tells a retry what was wrong with its previous report", async () => {
    const { reviewerCalls } = await runReview({
      "reviewer:code-r0": { attempts: [{ report: { findings: "none" } }, {}] },
    });
    expect(reviewerCalls).toHaveLength(2);
    expect(reviewerCalls[0]!.prompt).not.toContain("## Previous attempt");
    expect(reviewerCalls[1]!.prompt).toContain("## Previous attempt");
    expect(reviewerCalls[1]!.prompt).toContain("does not match the schema");
    expect(reviewerCalls[1]!.prompt).toMatch(/"findings":\s*"none"/);
  });

  it("stores blockers and majors without a failure scenario as minor and exits 0", async () => {
    const vague = { ...blocker, failureScenario: undefined };
    const { result, reportFile } = await runReview({
      "reviewer:code-r0": {
        attempts: [
          {
            report: {
              findings: [vague, { ...vague, id: "F2", severity: "major" }],
            },
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    const report = reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8")));
    expect(report.findings.map((f) => f.severity)).toEqual(["minor", "minor"]);
    expect(lines).toContain("code review round 0: 0 blocker, 0 major, 2 minor");
  });

  it("sends an open blocker to the fixer", async () => {
    const { result, provider } = await runReview({
      "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("code review round 0: 1 blocker, 0 major, 0 minor");
    expect(provider.calls.filter((c) => c.role === "fixer")).toHaveLength(1);
  });

  it("removes the reviewer's worktree and keeps its edits off the integration branch", async () => {
    const { ctx, result, reviewerCalls } = await runReview({
      "reviewer:code-r0": {
        attempts: [{ write: { "1.txt": "vandalized\n", "extra.txt": "x\n" } }],
      },
    });
    expect(result.exitCode).toBe(0);
    const worktree = reviewerCalls[0]!.cwd;
    expect(existsSync(worktree)).toBe(false);
    expect(await gitOut(repo, ["worktree", "list"])).not.toContain("review-code-r0");
    const branch = `graph/${ctx.runId}`;
    expect(await gitOut(repo, ["show", `${branch}:1.txt`])).toBe("1");
    expect((await gitOut(repo, ["ls-tree", "--name-only", branch])).split("\n")).not.toContain("extra.txt");
  });

  it("aborts with exit code 2 when the integration branch head moves during the review", async () => {
    const { ctx, result, reviewerCalls } = await runReview(
      {},
      {
        wrap: (p) => ({
          name: p.name,
          run(opts): AgentRun {
            if (opts.role !== "reviewer") return p.run(opts);
            const inner = (async () => {
              const branch = (await gitOut(repo, ["branch", "--list", "graph/*", "--format=%(refname)"])).split(
                "\n",
              )[0]!;
              // A stray commit in the reviewer's checkout, then the branch moved onto it.
              await execa("git", ["commit", "--allow-empty", "-q", "-m", "stray"], { cwd: opts.cwd });
              await execa("git", ["update-ref", branch, "HEAD"], {
                cwd: opts.cwd,
              });
              return p.run(opts);
            })();
            return {
              events: (async function* () {
                yield* (await inner).events;
              })(),
              done: inner.then((r) => r.done),
            };
          },
        }),
      },
    );
    expect(reviewerCalls).toHaveLength(1);
    expect(result.exitCode).toBe(2);
    expect(lines.some((l) => l.startsWith(`aborted at review round 0: graph/${ctx.runId} moved from`))).toBe(true);
  });

  it("runs the validation gate on the integration branch first and aborts with a clear message when it fails", async () => {
    // Task validation is off; only the gate before the review runs the config's command.
    const tasks = (await loadTasks(tasksDir)).map((t) => ({
      ...t,
      validate: false as const,
    }));
    await writeFile(path.join(repo, CONFIG_FILE), JSON.stringify({ validate: ['node -e "process.exit(3)"'] }));
    const provider = createFakeProvider();
    const ctx = await startup({
      cwd: repo,
      provider: "fake",
      providerInstance: provider,
      log,
    });
    const result = await run(ctx, tasks, {
      specPath: spec,
      tasksDir,
      log,
      concurrency: 1,
    });
    expect(result.exitCode).toBe(2);
    expect(provider.calls.filter((c) => c.role === "reviewer")).toHaveLength(0);
    expect(
      lines.some(
        (l) => l.includes(`validation of graph/${ctx.runId} failed before the review`) && l.includes("code 3"),
      ),
    ).toBe(true);
  });
});

describe("validation fixer before the review", () => {
  /** Fails until the first validation fixer's default commit, `fix-r0-v1.txt`, exists. */
  const UNTIL_FIXED = `node -e ${JSON.stringify(
    `if (!require("fs").existsSync("fix-r0-v1.txt")) { console.error("merged tasks are broken"); process.exit(4); }`,
  )}`;

  it("sends a failing gate to the fixer, validates again and goes on to the review", async () => {
    const events = new RunEmitter();
    const agents: string[] = [];
    const tracked: string[] = [];
    events.on(
      "changes:track",
      ({ nodeId, worktree }) => nodeId === "@gate-fixer" && tracked.push(`track ${nodeId} ${worktree}`),
    );
    events.on("changes:stop", ({ nodeId }) => nodeId === "@gate-fixer" && tracked.push(`stop ${nodeId}`));
    events.on("agent:status", ({ agent, status, label }) => {
      if (agent === "gateFixer") agents.push(`${status}${label ? ` ${label}` : ""}`);
    });
    events.on("agent:end", ({ agent, label, ok }) => {
      if (agent === "gateFixer") agents.push(`end ${label} ${ok}`);
    });
    const { provider, ctx, result, reviewerCalls } = await runReview(
      {},
      { config: { validate: [UNTIL_FIXED] }, noTaskValidation: true, events },
    );
    expect(result.exitCode).toBe(0);
    const fixerCalls = provider.calls.filter((c) => c.role === "fixer");
    expect(fixerCalls.map((c) => c.label)).toEqual(["fix-r0-v1"]);
    expect(fixerCalls[0]!.cwd).toBe(path.join(ctx.runDir, "worktrees", "integration"));
    expect(fixerCalls[0]!.prompt).toContain("merged tasks are broken");
    expect(fixerCalls[0]!.prompt).not.toContain("Blocker and major findings");
    expect(reviewerCalls).toHaveLength(1);
    expect(existsSync(fixerSummaryPath(ctx.runDir, 0, 1))).toBe(true);
    expect(await gitOut(repo, ["show", `graph/${ctx.runId}:fix-r0-v1.txt`])).toBe("fix-r0-v1");
    expect(agents).toEqual(["fixing fix-r0-v1", "validating", "end fix-r0-v1 true"]);
    expect(tracked.map((t) => t.split(" ")[0])).toEqual(["track", "stop"]);
    expect(tracked[0]).toContain("@gate-fixer");
    expect(tracked[1]).toBe("stop @gate-fixer");
    expect(lines.some((l) => l.includes("sent to the fixer (validation fix round 1/3)"))).toBe(true);
  });

  it("aborts after validationRounds fixer rounds that do not fix it, without reviewing", async () => {
    const { provider, ctx, result, reviewerCalls } = await runReview(
      {},
      {
        config: {
          validate: ['node -e "process.exit(3)"'],
          validationRounds: 2,
        },
        noTaskValidation: true,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(provider.calls.filter((c) => c.role === "fixer").map((c) => c.label)).toEqual(["fix-r0-v1", "fix-r0-v2"]);
    expect(reviewerCalls).toHaveLength(0);
    expect(
      lines.some((l) => l.includes(`validation of graph/${ctx.runId} failed before the review after 2 fix round(s)`)),
    ).toBe(true);
  });

  it("with validateAt end, skips every task's own gate and only validates the merged result", async () => {
    // The tasks' commands would fail; with validateAt end they never run.
    const { provider, result, reviewerCalls } = await runReview(
      {},
      { config: { validate: [UNTIL_FIXED], validateAt: "end" } },
    );
    expect(result.exitCode).toBe(0);
    const taskCalls = provider.calls.filter((c) => c.role === "task");
    expect(taskCalls).toHaveLength(4);
    expect(provider.calls.filter((c) => c.role === "fixer").map((c) => c.label)).toEqual(["fix-r0-v1"]);
    expect(reviewerCalls).toHaveLength(1);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("live tester", () => {
  it("runs next to the code reviewer, each in its own worktree, and both reports exist", async () => {
    let started = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const listings: string[] = [];
    const { ctx, result, reviewerCalls, testerCalls, reportFile, testerFile } = await runReview(
      {},
      {
        wrap: (p) => ({
          name: p.name,
          run(opts): AgentRun {
            if (opts.role !== "reviewer" && opts.role !== "tester") return p.run(opts);
            if (++started === 2) release();
            const inner = (async () => {
              // Sequential reviewers would never get here: the first would wait for a second that never starts.
              await Promise.race([
                both,
                new Promise((_, reject) => setTimeout(() => reject(new Error("reviewers did not overlap")), 5000)),
              ]);
              listings.push(await gitOut(repo, ["worktree", "list"]));
              return p.run(opts);
            })();
            return {
              events: (async function* () {
                yield* (await inner).events;
              })(),
              done: inner.then((r) => r.done),
            };
          },
        }),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(1);
    expect(testerCalls).toHaveLength(1);
    expect(path.basename(testerCalls[0]!.cwd)).toBe("review-tester-r0");
    expect(listings).toHaveLength(2);
    for (const listing of listings) {
      expect(listing).toContain("review-code-r0");
      expect(listing).toContain("review-tester-r0");
    }
    expect(existsSync(testerCalls[0]!.cwd)).toBe(false);
    expect(testerFile).toBe(path.join(ctx.runDir, "reports", "round0", "tester.json"));
    expect(reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8"))).reviewer).toBe("code");
    expect(reportSchema.parse(JSON.parse(await readFile(testerFile, "utf8")))).toMatchObject({
      round: 0,
      reviewer: "tester",
      findings: [],
    });
    expect(lines).toContain("live test round 0: 0 blocker, 0 major, 0 minor");
  });

  it("gives the tester the spec, the tasks folder, the changed files and TESTING.md, but not the diff", async () => {
    // Uncommitted on purpose: the tool reads it from the repo root, not from the throwaway worktree.
    await writeFile(path.join(repo, "TESTING.md"), "Boot with `npm start`, then GET http://localhost:3000/health.\n");
    const { ctx, testerCalls, result } = await runReview();
    expect(result.exitCode).toBe(0);
    const prompt = testerCalls[0]!.prompt;
    expect(prompt).toContain((await readFile(spec, "utf8")).trim());
    expect(prompt).toContain(tasksDir);
    for (const file of ["1.txt", "2.txt", "3.txt", "4.txt"]) expect(prompt).toContain(`- ${file}`);
    expect(prompt).toContain("GET http://localhost:3000/health.");
    expect(prompt).toContain("Follow TESTING.md");
    expect(prompt).toContain(testerReportPath(ctx.runDir, 0));
    expect(prompt).toContain("live test not performed");
    expect(prompt).toMatch(/Stop every server or process you started/);
    expect(prompt).not.toContain("diff --git");
    expect(prompt).not.toContain("+++ b/");
    expect(lines.some((l) => l.includes("no TESTING.md"))).toBe(false);
  });

  it("runs without TESTING.md from the README and scripts", async () => {
    const { result, testerCalls } = await runReview();
    expect(result.exitCode).toBe(0);
    expect(testerCalls).toHaveLength(1);
    expect(testerCalls[0]!.prompt).toContain("There is no TESTING.md");
    expect(testerCalls[0]!.prompt).not.toContain("(TESTING.md)");
    expect(lines.some((l) => l.includes("no TESTING.md"))).toBe(true);
  });

  it("exits 0 and carries the note when the app could not be run", async () => {
    const note = "live test not performed: no start script and no TESTING.md";
    const { result, testerFile } = await runReview({
      "tester:tester-r0": { attempts: [{ report: { notes: [note] } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(reportSchema.parse(JSON.parse(await readFile(testerFile, "utf8"))).notes).toEqual([note]);
    expect(lines).toContain(`note: ${note}`);
    expect(lines.some((l) => l.startsWith("aborted"))).toBe(false);
  });

  it("retries only the tester when it fails and the code reviewer succeeded", async () => {
    const { result, reviewerCalls, testerCalls, testerFile } = await runReview({
      "tester:tester-r0": {
        attempts: [{ exitCode: 1 }, { report: { reviewer: "code" } }, {}],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(1);
    expect(testerCalls).toHaveLength(3);
    expect(lines.some((l) => l.startsWith("live test round 0: tester exited with code 1; retry 2/3"))).toBe(true);
    expect(lines.some((l) => l.includes('must have round 0 and reviewer "tester"') && l.includes("retry 3/3"))).toBe(
      true,
    );
    expect(reportSchema.parse(JSON.parse(await readFile(testerFile, "utf8"))).reviewer).toBe("tester");
  });

  it("continues with a 'live test not performed' note after three failed tester attempts", async () => {
    const { result, reviewerCalls, testerCalls } = await runReview({
      "tester:tester-r0": {
        attempts: [{ exitCode: 1 }, { exitCode: 1 }, { report: null }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(1);
    expect(testerCalls).toHaveLength(3);
    expect(
      lines.some((l) => l.startsWith("note: live test not performed: live test round 0 failed after 3 attempts")),
    ).toBe(true);
  });

  it("keeps the previous round's unresolved findings open when a reviewer gives up in a re-review", async () => {
    const { result } = await runReview({
      "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
      "reviewer:code-r1": {
        attempts: [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }],
      },
      "reviewer:code-r2": {
        attempts: [{ report: { findings: [{ ...blocker, status: "fixed" }] } }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("code review round 1: 1 blocker, 0 major, 0 minor");
  });

  it("sends an open major of the tester to the fixer", async () => {
    const major = { ...blocker, id: "T1", severity: "major" };
    const { result, provider } = await runReview({
      "tester:tester-r0": { attempts: [{ report: { findings: [major] } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("live test round 0: 0 blocker, 1 major, 0 minor");
    const fixer = provider.calls.filter((c) => c.role === "fixer");
    expect(fixer).toHaveLength(1);
    expect(fixer[0]!.prompt).toContain("**T1** (major, Live test)");
  });

  it("retries a tester report that misses a plan case, telling the next attempt which", async () => {
    const pass = (id: string) => ({ id, verdict: "pass", evidence: "ok" });
    const { result, testerCalls } = await runReview(
      {
        "tester:tester-r0": {
          attempts: [{ report: { cases: [pass("P1")] } }, { report: { cases: [pass("P1"), pass("P2")] } }],
        },
      },
      { tasksDir: fixture("plan-ok") },
    );
    expect(result.exitCode).toBe(0);
    expect(testerCalls).toHaveLength(2);
    expect(lines).toContain("live test round 0: the report has no verdict for case(s) P2; retry 2/3");
    expect(testerCalls[0]!.prompt).toContain("## Test plan");
    expect(testerCalls[1]!.prompt).toContain("## Previous attempt");
    expect(testerCalls[1]!.prompt).toContain("no verdict for case(s) P2");
  });

  it("accepts a tester report that passes every plan case and saves the cases", async () => {
    const pass = (id: string) => ({ id, verdict: "pass", evidence: "ok" });
    const { result, testerCalls, testerFile } = await runReview(
      {
        "tester:tester-r0": {
          attempts: [{ report: { cases: [pass("P1"), pass("P2")] } }],
        },
      },
      { tasksDir: fixture("plan-ok") },
    );
    expect(result.exitCode).toBe(0);
    expect(testerCalls).toHaveLength(1);
    expect(reportSchema.parse(JSON.parse(await readFile(testerFile, "utf8"))).cases).toHaveLength(2);
  });

  it("kills the processes the tester left running once it exits", async () => {
    const { provider, result } = await runReview({
      "tester:tester-r0": { attempts: [{ orphan: true }] },
    });
    expect(result.exitCode).toBe(0);
    expect(provider.pids).toHaveLength(1);
    const pid = provider.pids[0]!;
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });
});

describe("test plan verdicts", () => {
  const c = (id: string, verdict: string, evidence = "ev") => ({ id, verdict, evidence });
  const plan = { tasksDir: fixture("plan-ok") };
  const testerJson = async (ctx: { runDir: string }, round: number) =>
    reportSchema.parse(JSON.parse(await readFile(testerReportPath(ctx.runDir, round), "utf8")));

  it("turns a failing must case into a blocker for the fixer and marks it fixed when it passes", async () => {
    const { result, provider, ctx } = await runReview(
      {
        "tester:tester-r0": { attempts: [{ report: { cases: [c("P1", "fail", "GET /me → 200"), c("P2", "pass")] } }] },
        "tester:tester-r1": { attempts: [{ report: { cases: [c("P1", "pass", "401"), c("P2", "pass")] } }] },
      },
      plan,
    );
    expect(result.exitCode).toBe(0);
    const fixer = provider.calls.filter((x) => x.role === "fixer");
    expect(fixer[0]!.prompt).toContain("**plan-P1** (blocker, Live test)");
    const r1 = await testerJson(ctx, 1);
    expect(r1.findings.find((f) => f.id === "plan-P1")?.status).toBe("fixed");
    expect(r1.cases?.[0]).toMatchObject({ title: "Login works", priority: "must" });
  });

  it("exits 1 when a must case still fails after the last fix pass", async () => {
    const failing = { attempts: [{ report: { cases: [c("P1", "fail"), c("P2", "pass")] } }] };
    const { result } = await runReview(
      { "tester:tester-r0": failing, "tester:tester-r1": failing },
      { ...plan, config: { fixPasses: 1 } },
    );
    expect(result.exitCode).toBe(1);
  });

  it("makes a failing should case a major finding", async () => {
    const { provider } = await runReview(
      { "tester:tester-r0": { attempts: [{ report: { cases: [c("P1", "pass"), c("P2", "fail")] } }] } },
      plan,
    );
    const fixer = provider.calls.filter((x) => x.role === "fixer");
    expect(fixer[0]!.prompt).toContain("**plan-P2** (major, Live test)");
  });

  it("blocks the cases the tester keeps leaving out and keeps the reported ones", async () => {
    const partial = { report: { cases: [c("P1", "pass")] } };
    const { ctx } = await runReview(
      { "tester:tester-r0": { attempts: [partial, partial, partial] } },
      plan,
    );
    const r0 = await testerJson(ctx, 0);
    expect(r0.cases?.map((x) => [x.id, x.verdict])).toEqual([
      ["P1", "pass"],
      ["P2", "blocked"],
    ]);
    expect(r0.findings.map((f) => f.id)).toEqual(["plan-P2"]);
  });

  it("leaves the plan verdicts out of the previous report shown to the tester", async () => {
    const { testerCalls } = await runReview(
      {
        "tester:tester-r0": { attempts: [{ report: { cases: [c("P1", "fail"), c("P2", "pass")] } }] },
        "tester:tester-r1": { attempts: [{ report: { cases: [c("P1", "pass"), c("P2", "pass")] } }] },
      },
      plan,
    );
    const section = testerCalls[1]!.prompt.split("## Previous report")[1]!.split("## Fixer's commit summary")[0]!;
    expect(section).not.toContain("plan-");
    expect(section).not.toContain('"cases"');
  });
});

describe("fix-pass loop", () => {
  const reviews = (n: number, findings: unknown[]) => ({
    attempts: Array.from({ length: n }, () => ({ report: { findings } })),
  });
  const scripted = (rounds: Record<number, unknown[]>) =>
    Object.fromEntries(Object.entries(rounds).map(([r, findings]) => [`reviewer:code-r${r}`, reviews(1, findings)]));
  const fixerCalls = (p: FakeProvider) => p.calls.filter((c) => c.role === "fixer");
  const minor = {
    id: "F2",
    severity: "minor",
    description: "Naming could be clearer.",
    status: "open",
  };

  it("ends clean after a clean first review without calling the fixer", async () => {
    const { result, provider } = await runReview();
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)).toHaveLength(0);
  });

  it("fixes a blocker in the integration worktree, validates, re-reviews and exits 0 after one pass", async () => {
    const { ctx, result, provider, reviewerCalls, testerCalls } = await runReview(
      scripted({ 0: [blocker], 1: [{ ...blocker, status: "fixed" }] }),
      { config: { validate: ['node -e "process.exit(0)"'] } },
    );
    expect(result.exitCode).toBe(0);
    const fixer = fixerCalls(provider);
    expect(fixer).toHaveLength(1);
    expect(fixer[0]!.cwd).toBe(path.join(ctx.runDir, "worktrees", "integration"));
    expect(fixer[0]!.label).toBe("fix-r1");
    expect(reviewerCalls.map((c) => c.label)).toEqual(["code-r0", "code-r1"]);
    expect(testerCalls.map((c) => c.label)).toEqual(["tester-r0", "tester-r1"]);
    expect(lines).toContain("1 open blocker/major finding(s); fix pass 1/3");
    expect(lines.indexOf(`validating graph/${ctx.runId} after fix pass 1`)).toBeGreaterThan(-1);
    // The fixer's commit is on the integration branch.
    expect(await gitOut(repo, ["log", "-1", "--format=%s", `graph/${ctx.runId}`])).toBe("fake: fixer:fix-r1 attempt 1");
    expect(await gitOut(repo, ["show", `graph/${ctx.runId}:fix-r1.txt`])).toBe("fix-r1");
  });

  it("tracks the fixer's changes in the integration worktree from the head it started at", async () => {
    const events = new RunEmitter();
    const tracked: string[] = [];
    events.on(
      "changes:track",
      ({ nodeId, worktree, base }) => nodeId === "@fixer" && tracked.push(`track ${nodeId} ${worktree} ${base}`),
    );
    events.on("changes:stop", ({ nodeId }) => nodeId === "@fixer" && tracked.push(`stop ${nodeId}`));
    const { ctx } = await runReview(scripted({ 0: [blocker], 1: [{ ...blocker, status: "fixed" }] }), {
      config: { validate: ['node -e "process.exit(0)"'] },
      events,
    });
    const integration = path.join(ctx.runDir, "worktrees", "integration");
    expect(tracked).toHaveLength(2);
    expect(tracked[0]).toMatch(new RegExp(`^track @fixer ${integration} [0-9a-f]{40}$`));
    expect(tracked[1]).toBe("stop @fixer");
  });

  it("performs exactly 3 fix passes and 4 reviews, then exits 1 keeping branch, worktrees and reports", async () => {
    const notFixed = { ...blocker, status: "not_fixed" };
    const { ctx, result, provider, reviewerCalls, testerCalls } = await runReview(
      scripted({ 0: [blocker], 1: [notFixed], 2: [notFixed], 3: [notFixed] }),
    );
    expect(result.exitCode).toBe(1);
    expect(fixerCalls(provider).map((c) => c.label)).toEqual(["fix-r1", "fix-r2", "fix-r3"]);
    expect(reviewerCalls).toHaveLength(4);
    expect(testerCalls).toHaveLength(4);
    expect(lines.some((l) => l.includes("remain on") && l.includes("after 3 fix pass(es)"))).toBe(true);
    expect(await gitOut(repo, ["branch", "--list", `graph/${ctx.runId}`])).toContain(`graph/${ctx.runId}`);
    expect(existsSync(path.join(ctx.runDir, "worktrees", "integration"))).toBe(true);
    for (const round of [0, 1, 2, 3]) {
      expect(existsSync(codeReportPath(ctx.runDir, round))).toBe(true);
      expect(existsSync(testerReportPath(ctx.runDir, round))).toBe(true);
    }
  });

  it("honors config.fixPasses", async () => {
    const { result, provider, reviewerCalls } = await runReview(scripted({ 0: [blocker], 1: [blocker] }), {
      config: { fixPasses: 1 },
    });
    expect(result.exitCode).toBe(1);
    expect(fixerCalls(provider)).toHaveLength(1);
    expect(reviewerCalls).toHaveLength(2);
  });

  it("never runs a fix pass for minors alone and keeps them in the final report data", async () => {
    const { result, provider, reportFile } = await runReview(scripted({ 0: [minor] }));
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)).toHaveLength(0);
    const report = reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8")));
    expect(report.findings).toMatchObject([{ id: "F2", severity: "minor" }]);
  });

  it("feeds a failing gate after the fixer back to it in a validation round that does not consume a fix pass", async () => {
    // Fails only once the fix pass's own commit is there and the validation fix is not.
    const check = `node -e "const f=require('fs');process.exit(f.existsSync('fix-r1.txt')&&!f.existsSync('ok.txt')?4:0)"`;
    const { result, provider, reviewerCalls, ctx } = await runReview(
      {
        ...scripted({ 0: [blocker], 1: [blocker], 2: [] }),
        "fixer:fix-r1-v1": { attempts: [{ write: { "ok.txt": "ok\n" } }] },
      },
      { config: { validate: [check], fixPasses: 2 }, noTaskValidation: true },
    );
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider).map((c) => c.label)).toEqual(["fix-r1", "fix-r1-v1", "fix-r2"]);
    expect(reviewerCalls).toHaveLength(3);
    expect(
      lines.some(
        (l) =>
          l.includes("fix pass 1: validation failed:") &&
          l.includes("(exit code 4); output in logs/fix-pass1-validate-1.log"),
      ),
    ).toBe(true);
    expect(lines).toContain("fix pass 1: sent back to the fixer (round 1/3)");
    expect(await readFile(path.join(ctx.runDir, "logs", "fix-pass1-validate-1.log"), "utf8")).toContain(
      "(exit code 4)",
    );
    const validationPrompt = fixerCalls(provider)[1]!;
    expect(validationPrompt.prompt).toContain("Your committed fix fails a validation command.");
    expect(validationPrompt.prompt).toContain(check);
  });

  it("aborts with exit code 2 when the validation rounds after a fix are exhausted", async () => {
    const check = `node -e "process.exit(require('fs').existsSync('fix-r1.txt')?5:0)"`;
    const { result, provider, reviewerCalls } = await runReview(scripted({ 0: [blocker] }), {
      config: { validate: [check], validationRounds: 2 },
      noTaskValidation: true,
    });
    expect(result.exitCode).toBe(2);
    expect(fixerCalls(provider).map((c) => c.label)).toEqual(["fix-r1", "fix-r1-v1", "fix-r1-v2"]);
    expect(reviewerCalls).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("aborted at fix pass 1 validation: validation failed after 2 rounds"))).toBe(
      true,
    );
  });

  it("commits what a finished fixer left uncommitted instead of retrying it", async () => {
    const { result, provider } = await runReview({
      ...scripted({ 0: [blocker] }),
      "fixer:fix-r1": { attempts: [{ commit: false }] },
    });
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)).toHaveLength(1);
    expect(lines).toContain("fix pass 1: committed changes the fixer left uncommitted");
  });

  it("retries a fixer that made no commit", async () => {
    const { result, provider } = await runReview({
      ...scripted({ 0: [blocker] }),
      "fixer:fix-r1": { attempts: [{ commit: false, write: {} }, {}] },
    });
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)).toHaveLength(2);
    expect(lines).toContain("fix pass 1: the fixer made no commit; retry 2/3");
  });

  it("emits the phase, round, fix pass and review agent events for the UI", async () => {
    const events = new RunEmitter();
    const seen: string[] = [];
    let end: RunEnd | undefined;
    events.on("phase:change", (change) => seen.push(`phase ${phaseLabel(change)}`));
    events.on("review:start", ({ round }) => seen.push(`review:start ${round}`));
    events.on("review:end", ({ round, reports }) => seen.push(`review:end ${round} ${reports.length}`));
    events.on("fix:start", ({ pass, passes }) => seen.push(`fix:start ${pass}/${passes}`));
    events.on("fix:end", ({ pass }) => seen.push(`fix:end ${pass}`));
    events.on("agent:start", ({ agent, label }) => seen.push(`start ${agent} ${label}`));
    events.on("agent:retry", ({ agent, label, attempt, attempts }) =>
      seen.push(`retry ${agent} ${label} ${attempt}/${attempts}`),
    );
    events.on("agent:status", ({ agent, status }) => seen.push(`${status} ${agent}`));
    events.on("agent:end", ({ agent, label, ok }) => seen.push(`end ${agent} ${label} ${ok ? "ok" : "failed"}`));
    events.on("run:end", (e) => (end = e));
    const { ctx, result } = await runReview(
      {
        ...scripted({ 0: [blocker], 1: [{ ...blocker, status: "fixed" }] }),
        "fixer:fix-r1": { attempts: [{ exitCode: 1, commit: false }, {}] },
      },
      { config: { validate: ['node -e "process.exit(0)"'] }, events },
    );
    expect(result.exitCode).toBe(0);

    const only = (pattern: RegExp): string[] => seen.filter((l) => pattern.test(l));
    expect(only(/^phase /)).toEqual([
      "phase tasks",
      "phase validate",
      "phase review round 0",
      "phase fix pass 1/3",
      "phase review round 1",
      "phase done",
    ]);
    expect(only(/^(review|fix):/)).toEqual([
      "review:start 0",
      "review:end 0 2",
      "fix:start 1/3",
      "fix:end 1",
      "review:start 1",
      "review:end 1 2",
    ]);
    expect(only(/fixer/)).toEqual([
      "start fixer fix-r1",
      "retry fixer fix-r1 2/3",
      "validating fixer",
      "end fixer fix-r1 ok",
    ]);
    for (const label of ["reviewer code-r0", "tester tester-r0", "reviewer code-r1", "tester tester-r1"]) {
      expect(seen.indexOf(`end ${label} ok`)).toBeGreaterThan(seen.indexOf(`start ${label}`));
    }
    expect(end).toMatchObject({
      runId: ctx.runId,
      branch: `graph/${ctx.runId}`,
      exitCode: 0,
      fixPasses: 3,
    });
    expect(end!.reports.map((r) => [r.reviewer, r.round])).toEqual([
      ["code", 1],
      ["tester", 1],
    ]);
    expect(end!.abort).toBeUndefined();
  });

  it("ends the fixer node as failed and carries the last reports and the resume hint on an abort", async () => {
    const events = new RunEmitter();
    const ends: string[] = [];
    let end: RunEnd | undefined;
    events.on("agent:end", ({ agent, label, ok }) => ends.push(`${agent} ${label} ${ok ? "ok" : "failed"}`));
    events.on("run:end", (e) => (end = e));
    const crash = { exitCode: 1, commit: false };
    const { ctx, result } = await runReview(
      {
        ...scripted({ 0: [blocker] }),
        "fixer:fix-r1": { attempts: [crash, crash, crash] },
      },
      { events },
    );
    expect(result.exitCode).toBe(2);
    expect(ends.at(-1)).toBe("fixer fix-r1 failed");
    expect(end).toMatchObject({
      exitCode: 2,
      abort: {
        step: "fix pass 1",
        hint: `graph-execution --resume --run ${ctx.runId}`,
      },
    });
    expect(end!.reports.map((r) => [r.reviewer, r.round])).toEqual([
      ["code", 0],
      ["tester", 0],
    ]);
  });

  it("gives the fixer the spec and both reports, blockers and majors before minors", async () => {
    const major = {
      ...blocker,
      id: "T1",
      severity: "major",
      description: "Health endpoint returns 500.",
    };
    const { provider } = await runReview({
      ...scripted({ 0: [minor, blocker] }),
      "tester:tester-r0": { attempts: [{ report: { findings: [major] } }] },
    });
    const prompt = fixerCalls(provider)[0]!;
    expect(prompt.prompt).toContain((await readFile(spec, "utf8")).trim());
    expect(prompt.prompt).toContain("You cannot decline a finding.");
    expect(prompt.prompt).toMatch(/consistent with the specification/);
    const at = (text: string): number => prompt.prompt.indexOf(text);
    expect(at("**F1** (blocker, Code review)")).toBeGreaterThan(-1);
    expect(at("**T1** (major, Live test)")).toBeGreaterThan(at("**F1** (blocker"));
    expect(at("**F2** (minor, Code review)")).toBeGreaterThan(at("**T1** (major"));
    expect(at("## Minor findings (lower priority)")).toBeLessThan(at("**F2** (minor"));
  });

  it("gives round 1 reviewers the previous report and the fixer's commit summary", async () => {
    const { ctx, provider, reviewerCalls, testerCalls } = await runReview(scripted({ 0: [blocker] }));
    expect(fixerCalls(provider)).toHaveLength(1);
    const summary = "fake: fixer:fix-r1 attempt 1";
    expect((await readFile(fixerSummaryPath(ctx.runDir, 1), "utf8")).trim()).toBe(summary);
    expect(reviewerCalls[0]!.prompt).not.toContain("## Previous report");
    expect(reviewerCalls[0]!.prompt).not.toContain("Fixer's commit summary");
    for (const call of [reviewerCalls[1]!, testerCalls[1]!]) {
      expect(call.prompt).toContain("## Previous report");
      expect(call.prompt).toContain("## Fixer's commit summary");
      expect(call.prompt).toContain(summary);
      expect(call.prompt).toContain("`fixed` or");
    }
    expect(reviewerCalls[1]!.prompt).toContain(blocker.description);
    // The tester verifies its own previous report, not the code reviewer's.
    expect(testerCalls[1]!.prompt).not.toContain(blocker.description);
    // The re-review diff includes the fixer's commit.
    expect(reviewerCalls[1]!.prompt).toContain("+++ b/fix-r1.txt");
  });

  it("does not count a previous finding the reviewer marked fixed as open", async () => {
    const { result, provider } = await runReview(scripted({ 0: [blocker], 1: [{ ...blocker, status: "fixed" }] }));
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)).toHaveLength(1);
    expect(lines).toContain("code review round 1: 1 blocker, 0 major, 0 minor");
  });
});

describe("human review pause", () => {
  const scripted = (findings: unknown[]) => ({
    "reviewer:code-r0": { attempts: [{ report: { findings } }] },
  });

  const waiting = (events: RunEmitter) => {
    const seen: { round: number; reviewRound?: number; blocking: unknown[] }[] = [];
    events.on("review:waiting", (w) => seen.push(w));
    return seen;
  };

  it("waits after a clean loop and applies on request", async () => {
    const hub = new RetryHub();
    const events = new RunEmitter();
    const seen = waiting(events);
    const running = runReview({}, { config: { humanReview: true }, retry: hub, events });
    await hub.whenReviewWaiting();
    expect(seen).toEqual([{ round: 1, reviewRound: 0, blocking: [] }]);
    expect(hub.decide({ review: "apply" })).toEqual({ ok: true });
    const { result, ctx } = await running;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(ctx.runDir, "state.json"), "utf8")).review).toMatchObject({
      phase: "done",
      humanRound: 1,
    });
  });

  const reviews = (n: number, findings: unknown[]) => ({
    attempts: Array.from({ length: n }, () => ({ report: { findings } })),
  });
  const fixerCalls = (p: FakeProvider) => p.calls.filter((c) => c.role === "fixer");
  const runDirOf = async (): Promise<string> => {
    const root = path.join(repo, ".graph-execution");
    return path.join(root, (await readdir(root))[0]!);
  };
  const comment = async (body: string): Promise<void> => {
    await new HumanReviewStore(await runDirOf()).add({ body, file: "1.txt", line: 1, snippet: "x" });
  };

  it("request changes sends the comments to the fixer and pauses again", async () => {
    const hub = new RetryHub();
    const events = new RunEmitter();
    const labels: string[] = [];
    events.on("phase:change", (p) => labels.push(`phase ${phaseLabel(p)}`));
    const seen = waiting(events);
    const script = { "reviewer:code-r1": { attempts: [{ report: { comments: [{ id: "H1-1", verdict: "addressed", evidence: "1.txt:1" }] } }] } };
    const running = runReview(script, { config: { humanReview: true }, retry: hub, events });
    await hub.whenReviewWaiting();
    await comment("Paginate this");
    expect(hub.decide({ review: "changes" })).toEqual({ ok: true });
    await hub.whenReviewWaiting();
    expect(seen.map((w) => w.round)).toEqual([1, 2]);
    hub.decide({ review: "apply" });
    const { result, provider } = await running;
    expect(result.exitCode).toBe(0);
    const prompt = fixerCalls(provider)[0]!.prompt;
    expect(prompt).toContain("## Human review comments");
    expect(prompt).toContain("human-H1-1");
    expect(prompt.indexOf("## Human review comments")).toBeLessThan(prompt.indexOf("## Blocker and major"));
    expect(labels).toContain("phase fix pass 1/3 (human round 1)");
  });

  const verdict = (v: string, evidence = "src/a.ts:1 paginates") => ({
    comments: [{ id: "H1-1", verdict: v, evidence }],
  });
  /** Wraps the provider so each fixer run writes its note file at the path its prompt names. */
  const noting = (p: Provider): Provider => ({
    ...p,
    run(o) {
      const file = /`([^`]*fixer-comments\.json)`/.exec(o.prompt)?.[1];
      const agent = p.run(o);
      if (o.role !== "fixer" || !file) return agent;
      // Written before the fake agent's events finish, so before the fixer's commit is checked.
      return {
        ...agent,
        events: (async function* () {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify([{ id: "H1-1", note: "added limit/offset, capped at 50" }]));
          yield* agent.events;
        })(),
      } as AgentRun;
    },
  });

  it("asks the fixer for notes and re-reviews each comment until the reviewer says addressed", async () => {
    const hub = new RetryHub();
    const events = new RunEmitter();
    const seen = waiting(events);
    const script = {
      "reviewer:code-r1": { attempts: [{ report: verdict("not_addressed", "still unpaginated") }] },
      "reviewer:code-r2": { attempts: [{ report: verdict("addressed") }] },
    };
    const running = runReview(script, { config: { humanReview: true }, retry: hub, events, wrap: noting });
    await hub.whenReviewWaiting();
    await comment("Paginate this");
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    expect(seen.map((w) => w.round)).toEqual([1, 2]);
    hub.decide({ review: "apply" });
    const { result, provider, ctx } = await running;
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)).toHaveLength(2);
    expect(fixerCalls(provider)[0]!.prompt).toContain("fixer-comments.json");
    const code = async (r: number) => reportSchema.parse(JSON.parse(await readFile(codeReportPath(ctx.runDir, r), "utf8")));
    const first = (await code(1)).findings.find((f) => f.id === "human-H1-1");
    expect(first).toMatchObject({ severity: "blocker", status: "not_fixed" });
    expect(first?.failureScenario).toContain("still unpaginated");
    expect((await code(2)).findings.find((f) => f.id === "human-H1-1")).toMatchObject({ status: "fixed" });
    expect(await readFixerNotes(ctx.runDir, 1)).toEqual({ "H1-1": "added limit/offset, capped at 50" });
  });

  it("shows each comment's outcome, and sends reopened comments again but not resolved ones", async () => {
    const hub = new RetryHub();
    const script = {
      "reviewer:code-r1": { attempts: [{ report: verdict("addressed", "1.txt:1 paginates") }] },
      "reviewer:code-r2": { attempts: [{ report: verdict("addressed") }] },
    };
    const running = runReview(script, { config: { humanReview: true }, retry: hub, wrap: noting });
    await hub.whenReviewWaiting();
    await comment("Paginate this");
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    const dir = await runDirOf();
    const store = new HumanReviewStore(dir);
    const outcomes = await commentOutcomes(dir, 1, await allComments(dir, 2));
    expect(outcomes["H1-1"]).toEqual({ fixerNote: "added limit/offset, capped at 50", verdict: "addressed", evidence: "1.txt:1 paginates" });
    await store.reopen("H1-1", "Also cap the page size");
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    await store.resolve("H1-1");
    expect(openComments(await allComments(dir, 3))).toEqual([]);
    hub.decide({ review: "apply" });
    const { result, provider } = await running;
    expect(result.exitCode).toBe(0);
    const fixers = fixerCalls(provider);
    expect(fixers).toHaveLength(2);
    expect(fixers[1]!.prompt).toContain("Also cap the page size");
  });

  it("retries a code report that misses a comment verdict", async () => {
    const hub = new RetryHub();
    const script = { "reviewer:code-r1": { attempts: [{ report: {} }, { report: verdict("addressed") }] } };
    const running = runReview(script, { config: { humanReview: true }, retry: hub });
    await hub.whenReviewWaiting();
    await comment("Paginate this");
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    hub.decide({ review: "apply" });
    const { result, reviewerCalls } = await running;
    expect(result.exitCode).toBe(0);
    const r1 = reviewerCalls.filter((c) => c.label === "code-r1");
    expect(r1).toHaveLength(2);
    expect(r1[0]!.prompt).toContain("## Human review comments");
    expect(r1[1]!.prompt).toContain("no verdict for comment(s) H1-1");
  });

  it("gives every human round a fresh fix pass budget, without a limit", async () => {
    const hub = new RetryHub();
    const all: Record<string, unknown> = {};
    all["reviewer:code-r0"] = reviews(1, [blocker]);
    all["reviewer:code-r1"] = reviews(1, [blocker]);
    // Round r + 1 reviews after human round r's fix pass, with comments H1-1..Hr-1 open.
    for (let h = 1; h <= 3; h++) {
      const comments = Array.from({ length: h }, (_, i) => ({ id: `H${i + 1}-1`, verdict: "addressed", evidence: "1.txt:1" }));
      all[`reviewer:code-r${h + 1}`] = { attempts: [{ report: { findings: [blocker], comments } }] };
    }
    const running = runReview(all, { config: { humanReview: true, fixPasses: 1 }, retry: hub });
    await hub.whenReviewWaiting();
    for (let i = 1; i <= 3; i++) {
      await comment(`change ${i}`);
      hub.decide({ review: "changes" });
      await hub.whenReviewWaiting();
    }
    hub.decide({ review: "apply", force: true });
    const { result, provider } = await running;
    expect(result.exitCode).toBe(0);
    // One pass in the first loop plus exactly one per human round.
    expect(fixerCalls(provider)).toHaveLength(4);
  });

  it("needs force to apply with open findings after an exhausted loop", async () => {
    const hub = new RetryHub();
    const events = new RunEmitter();
    const seen = waiting(events);
    const running = runReview(scripted([blocker]), { config: { humanReview: true, fixPasses: 0 }, retry: hub, events });
    await hub.whenReviewWaiting();
    expect(seen[0]!.blocking).toHaveLength(1);
    hub.decide({ review: "apply" });
    await hub.whenReviewWaiting();
    hub.decide({ review: "apply", force: true });
    const { result } = await running;
    expect(result.exitCode).toBe(0);
  });

  it("drop exits 1 when findings are open and keeps the branch", async () => {
    const hub = new RetryHub();
    const running = runReview(scripted([blocker]), { config: { humanReview: true, fixPasses: 0 }, retry: hub });
    await hub.whenReviewWaiting();
    hub.decide({ review: "drop" });
    const { result, ctx } = await running;
    expect(result.exitCode).toBe(1);
    expect(await gitOut(repo, ["branch", "--list", `graph/${ctx.runId}`])).toContain(`graph/${ctx.runId}`);
    expect(existsSync(path.join(ctx.runDir, "worktrees", "integration"))).toBe(false);
  });

  it("drop exits 0 after a clean loop", async () => {
    const hub = new RetryHub();
    const running = runReview({}, { config: { humanReview: true }, retry: hub });
    await hub.whenReviewWaiting();
    hub.decide({ review: "drop" });
    expect((await running).result.exitCode).toBe(0);
  });

  it("quit while waiting aborts with exit 2 and leaves the state at human", async () => {
    const hub = new RetryHub();
    const running = runReview({}, { config: { humanReview: true }, retry: hub });
    await hub.whenReviewWaiting();
    hub.quit();
    const { result, ctx } = await running;
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(await readFile(path.join(ctx.runDir, "state.json"), "utf8")).review).toMatchObject({
      phase: "human",
      humanRound: 1,
    });
  });
});

describe("live-check comments", () => {
  const c = (id: string, verdict: string, evidence = "ev") => ({ id, verdict, evidence });
  const runDirOf = async (): Promise<string> => {
    const root = path.join(repo, ".graph-execution");
    return path.join(root, (await readdir(root))[0]!);
  };

  const addressed = Object.fromEntries(
    ["code-r1", "code-r2", "code-r3"].map((k) => [`reviewer:${k}`, { attempts: [{ report: { comments: [c("H1-1", "addressed"), c("H1-2", "addressed")] } }] }]),
  );

  async function withComments(script: Record<string, unknown>, extra: { tasksDir?: string } = {}) {
    const hub = new RetryHub();
    const running = runReview({ ...addressed, ...script }, { config: { humanReview: true }, retry: hub, ...extra });
    await hub.whenReviewWaiting();
    const store = new HumanReviewStore(await runDirOf());
    await store.add({ body: "Users list must be paginated", file: "1.txt", line: 1, liveCheck: true });
    await store.add({ body: "Rename this variable", file: "1.txt", line: 1 });
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    hub.decide({ review: "apply" });
    return running;
  }

  it("runs an open liveCheck comment as a must case until it passes, as a blocker while it fails", async () => {
    const { result, provider, testerCalls } = await withComments({
      "tester:tester-r1": { attempts: [{ report: { cases: [c("H1-1", "fail", "GET /users returns 500 rows")] } }] },
      "tester:tester-r2": { attempts: [{ report: { cases: [c("H1-1", "pass")] } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(testerCalls[0]!.prompt).not.toContain("H1-1");
    expect(testerCalls[1]!.prompt).toContain("### H1-1 (must):");
    expect(testerCalls[1]!.prompt).not.toContain("Rename this variable");
    expect(testerCalls[2]!.prompt).toContain("### H1-1 (must):");
    const fixers = provider.calls.filter((x) => x.role === "fixer");
    expect(fixers.some((x) => x.prompt.includes("plan-H1-1"))).toBe(true);
  });

  it("adds the cases to the run's own test plan", async () => {
    const { testerCalls } = await withComments(
      {
        "tester:tester-r0": { attempts: [{ report: { cases: [c("P1", "pass"), c("P2", "pass")] } }] },
        "tester:tester-r1": { attempts: [{ report: { cases: [c("P1", "pass"), c("P2", "pass"), c("H1-1", "pass")] } }] },
      },
      { tasksDir: fixture("plan-ok") },
    );
    const prompt = testerCalls[1]!.prompt;
    expect(prompt).toContain("### P1 (must)");
    expect(prompt).toContain("### H1-1 (must):");
  });
});
