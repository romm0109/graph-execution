import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { fixerSummaryPath } from "../agents/fixer.js";
import { codeReportPath } from "../agents/reviewer.js";
import { CONFIG_FILE } from "../config/config.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider } from "../providers/fake.js";
import type { AgentRun } from "../providers/types.js";
import { RunEmitter } from "../runner/events.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import { reportSchema } from "./report.js";
import { spec, tasksDir, repo, lines, log, blocker, runReview } from "../__fixtures__/review-phase.js";

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
    expect(result.exitCode).toBe(4);
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
