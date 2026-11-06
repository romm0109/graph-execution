import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { testerReportPath } from "../agents/tester.js";
import type { AgentRun } from "../providers/types.js";
import { reportSchema } from "./report.js";
import { fixture, spec, tasksDir, repo, lines, blocker, runReview, alive } from "../__fixtures__/review-phase.js";

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
