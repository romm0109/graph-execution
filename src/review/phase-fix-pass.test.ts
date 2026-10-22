import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { fixerSummaryPath } from "../agents/fixer.js";
import { codeReportPath } from "../agents/reviewer.js";
import { testerReportPath } from "../agents/tester.js";
import { type FakeProvider } from "../providers/fake.js";
import { phaseLabel, RunEmitter, type RunEnd } from "../runner/events.js";
import { reportSchema } from "./report.js";
import { spec, repo, lines, blocker, runReview } from "../__fixtures__/review-phase.js";

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
    expect(lines).toContain("code review round 1: 0 blocker, 0 major, 0 minor (1 fixed)");
  });
});
