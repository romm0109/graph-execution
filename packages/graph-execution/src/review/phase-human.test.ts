import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../__fixtures__/repo.js";
import { codeReportPath } from "../agents/reviewer.js";
import { type FakeProvider } from "../providers/fake.js";
import type { AgentRun, Provider } from "../providers/types.js";
import { phaseLabel, RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import { allComments, commentOutcomes, HumanReviewStore, openComments, readFixerNotes } from "./human.js";
import { reportSchema } from "./report.js";
import { fixture, repo, blocker, runReview } from "../__fixtures__/review-phase.js";

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
  const comment = async (body: string, range?: { startLine: number; endLine: number }): Promise<void> => {
    await new HumanReviewStore(await runDirOf()).add({ body, file: "1.txt", ...(range ?? { line: 1 }), snippet: "x" });
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

  it("shows a range comment as lines in the fixer prompt", async () => {
    const hub = new RetryHub();
    const script = { "reviewer:code-r1": { attempts: [{ report: { comments: [{ id: "H1-1", verdict: "addressed", evidence: "1.txt:2" }] } }] } };
    const running = runReview(script, { config: { humanReview: true }, retry: hub, events: new RunEmitter() });
    await hub.whenReviewWaiting();
    await comment("Paginate this", { startLine: 2, endLine: 3 });
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    hub.decide({ review: "apply" });
    const { provider } = await running;
    expect(fixerCalls(provider)[0]!.prompt).toContain("`1.txt` new lines 2–3");
  });

  it("lists a suggestion under its comment in the fixer prompt", async () => {
    const hub = new RetryHub();
    const script = { "reviewer:code-r1": { attempts: [{ report: { comments: [{ id: "H1-1", verdict: "addressed", evidence: "1.txt:2" }] } }] } };
    const running = runReview(script, { config: { humanReview: true }, retry: hub, events: new RunEmitter() });
    await hub.whenReviewWaiting();
    await comment("Cap it.\n\n```suggestion\nconst limit = 50;\n```", { startLine: 2, endLine: 3 });
    hub.decide({ review: "changes" });
    await hub.whenReviewWaiting();
    hub.decide({ review: "apply" });
    const { provider, reviewerCalls } = await running;
    const prompt = fixerCalls(provider)[0]!.prompt;
    expect(prompt).toContain("Suggested replacement for these lines");
    expect(prompt).toContain("const limit = 50;");
    expect(prompt).toContain("A suggested replacement replaces exactly the commented lines");
    expect(reviewerCalls.some((c) => c.prompt.includes("Suggested replacement (addressed only if"))).toBe(true);
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
