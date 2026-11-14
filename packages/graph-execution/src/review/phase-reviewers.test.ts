import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lines, repo, runReview } from "../__fixtures__/review-phase.js";
import { stateSchema } from "../state/state.js";
import { reportSchema } from "./report.js";

const code = { id: "code", type: "diff", name: "Code review", repoFile: "REVIEW.md" };
const tester = { id: "tester", type: "tester", name: "Live test", repoFile: "TESTING.md" };
const security = { id: "security", type: "diff", name: "Security", repoFile: "SECURITY_REVIEW.md" };

const stateOf = async (runDir: string) => stateSchema.parse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));
const reportOf = async (runDir: string, id: string) =>
  reportSchema.parse(JSON.parse(await readFile(path.join(runDir, "reports", "round0", `${id}.json`), "utf8")));

describe("review round driven by the reviewers file", () => {
  it("runs the built-in code reviewer and live tester without a reviewers file", async () => {
    const { ctx, result, reviewerCalls } = await runReview();
    expect(result.exitCode).toBe(0);
    expect((await readdir(path.join(ctx.runDir, "reports", "round0"))).filter((f) => f.endsWith(".json")).sort()).toEqual([
      "code.json",
      "tester.json",
    ]);
    expect(existsSync(path.join(ctx.runDir, "reviewers.json"))).toBe(false);
    expect((await stateOf(ctx.runDir)).hashes.reviewers).toBe("");
    expect(reviewerCalls.map((c) => path.basename(c.cwd))).toEqual(["review-code-r0"]);
  });

  it("runs every reviewer of the file, each with its own label, worktree and report", async () => {
    const { ctx, result, reviewerCalls, testerCalls, reviewersFile } = await runReview({}, { reviewers: { reviewers: [code, tester, security] } });
    expect(result.exitCode).toBe(0);
    expect((await reportOf(ctx.runDir, "security")).reviewer).toBe("security");
    const call = reviewerCalls.find((c) => c.label === "security-r0");
    expect(call?.role).toBe("reviewer");
    expect(path.basename(call!.cwd)).toBe("review-security-r0");
    expect(testerCalls).toHaveLength(1);

    const source = await readFile(reviewersFile!);
    const copy = await readFile(path.join(ctx.runDir, "reviewers.json"));
    expect(copy.equals(source)).toBe(true);
    const state = await stateOf(ctx.runDir);
    expect(state.hashes.reviewers).toBe(createHash("sha256").update(source).digest("hex"));
    expect(state.review.reports.security).toBe(path.join(ctx.runDir, "reports", "round0", "security.json"));
    expect(lines).toContain("Security round 0: 0 blocker, 0 major, 0 minor");
    expect(lines).toContain("code review round 0: 0 blocker, 0 major, 0 minor");
  });

  it("drops disabled reviewers", async () => {
    const { ctx, result, testerCalls } = await runReview({}, { reviewers: { reviewers: [code, { ...tester, enabled: false }] } });
    expect(result.exitCode).toBe(0);
    expect(testerCalls).toHaveLength(0);
    expect(existsSync(path.join(ctx.runDir, "reports", "round0", "tester.json"))).toBe(false);
  });

  it("goes on to apply without a review when no reviewer is enabled", async () => {
    const { result, reviewerCalls, testerCalls } = await runReview({}, { reviewers: { reviewers: [] } });
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls).toHaveLength(0);
    expect(testerCalls).toHaveLength(0);
    expect(lines).toContain("no reviewers enabled; the result is not reviewed");
  });

  it("notes a reviewer that gave up with its name, and the run still ends clean", async () => {
    const { ctx, result } = await runReview(
      { "reviewer:security-r0": { attempts: [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }] } },
      { reviewers: { reviewers: [code, tester, security] } },
    );
    expect(result.exitCode).toBe(0);
    expect((await reportOf(ctx.runDir, "security")).notes?.[0]).toMatch(/^Security not performed/);
  });

  it("names the reviewer of a finding in the fixer's prompt", async () => {
    const finding = { id: "F1", severity: "major", description: "x", failureScenario: "y", status: "open" };
    const { provider } = await runReview(
      { "reviewer:security-r0": { attempts: [{ report: { findings: [finding] } }] } },
      { reviewers: { reviewers: [code, tester, security] } },
    );
    const fixer = provider.calls.find((c) => c.role === "fixer");
    expect(fixer?.prompt).toContain("(major, Security)");
    expect(fixer?.prompt).toContain("### Security");
  });
});

describe("each reviewer's own instructions, repo file and files filter", () => {
  it("gives each reviewer only its own repo-root file, even uncommitted", async () => {
    await writeFile(path.join(repo, "SECURITY_REVIEW.md"), "SEC-MARKER\n");
    await writeFile(path.join(repo, "REVIEW.md"), "REVIEW-MARKER\n");
    const { result, reviewerCalls, testerCalls } = await runReview({}, { reviewers: { reviewers: [code, tester, security] } });
    expect(result.exitCode).toBe(0);
    const sec = reviewerCalls.find((c) => c.label === "security-r0")!.prompt;
    expect(sec).toContain("## Review rules (SECURITY_REVIEW.md)");
    expect(sec).toContain("SEC-MARKER");
    expect(sec).not.toContain("REVIEW-MARKER");
    expect(sec).not.toContain("You are the code reviewer");
    const cr = reviewerCalls.find((c) => c.label === "code-r0")!.prompt;
    expect(cr).toContain("REVIEW-MARKER");
    expect(cr).not.toContain("SEC-MARKER");
    expect(testerCalls[0]!.prompt).not.toContain("SEC-MARKER");
    expect(testerCalls[0]!.prompt).not.toContain("REVIEW-MARKER");
    expect(lines).not.toContain("no SECURITY_REVIEW.md at the repo root; Security works from its instructions");
  });

  it("logs a missing repo file and still runs the reviewer", async () => {
    const { result, reviewerCalls } = await runReview({}, { reviewers: { reviewers: [code, security] } });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("no SECURITY_REVIEW.md at the repo root; Security works from its instructions");
    expect(lines).toContain("no REVIEW.md at the repo root; the code reviewer applies general rules");
    expect(reviewerCalls.some((c) => c.label === "security-r0")).toBe(true);
  });

  it("writes a not-needed report without running the agent when no changed file matches its files", async () => {
    const { ctx, result, reviewerCalls } = await runReview({}, { reviewers: { reviewers: [code, { ...security, files: ["nothing/**"] }] } });
    expect(result.exitCode).toBe(0);
    expect((await reportOf(ctx.runDir, "security")).notes).toEqual(["Security not needed: no changed file matches its files"]);
    expect(reviewerCalls.some((c) => c.label === "security-r0")).toBe(false);
  });

  it("limits the diff to the files matching its globs", async () => {
    const { result, reviewerCalls } = await runReview({}, { reviewers: { reviewers: [code, { ...security, files: ["1.txt"] }] } });
    expect(result.exitCode).toBe(0);
    const sec = reviewerCalls.find((c) => c.label === "security-r0")!.prompt;
    expect(sec).toContain("+++ b/1.txt");
    expect(sec).not.toContain("+++ b/2.txt");
    expect(reviewerCalls.find((c) => c.label === "code-r0")!.prompt).toContain("+++ b/2.txt");
  });

  it("gives the tester its own instructions and repo file", async () => {
    await writeFile(path.join(repo, "QA.md"), "QA-MARKER\n");
    const { result, testerCalls } = await runReview(
      {},
      { reviewers: { reviewers: [{ ...tester, instructions: "Only check the API.", repoFile: "QA.md" }] } },
    );
    expect(result.exitCode).toBe(0);
    const prompt = testerCalls[0]!.prompt;
    expect(prompt.startsWith("Only check the API.\n")).toBe(true);
    expect(prompt).toContain("## How to test this app (QA.md)");
    expect(prompt).toContain("QA-MARKER");
    expect(prompt).toContain("- Follow QA.md above:");
  });
});

describe("each reviewer's blockAt, finding ids, provider and model", () => {
  const major = { id: "F1", severity: "major", title: "Unsafe", description: "x", failureScenario: "y", status: "open" };
  const fixers = <T extends { role: string }>(calls: T[]): T[] => calls.filter((c) => c.role === "fixer");

  it("prefixes another reviewer's finding ids and keeps them across rounds", async () => {
    const { ctx, result, provider, reviewerCalls } = await runReview(
      { "reviewer:security-r0": { attempts: [{ report: { findings: [major] } }] } },
      { reviewers: { reviewers: [code, tester, security] } },
    );
    expect(result.exitCode).toBe(0);
    expect((await reportOf(ctx.runDir, "security")).findings.map((f) => f.id)).toEqual(["security-F1"]);
    expect(fixers(provider.calls)[0]!.prompt).toContain("**security-F1** (major, Security)");
    expect(reviewerCalls.find((c) => c.label === "security-r1")!.prompt).toContain('"id": "security-F1"');
  });

  it("reports every finding of a blockAt never reviewer as minor and starts no fix pass", async () => {
    const { ctx, result, provider } = await runReview(
      { "reviewer:security-r0": { attempts: [{ report: { findings: [major] } }] } },
      { reviewers: { reviewers: [code, { ...security, blockAt: "never" }] } },
    );
    expect(result.exitCode).toBe(0);
    expect(fixers(provider.calls)).toHaveLength(0);
    const report = await reportOf(ctx.runDir, "security");
    expect(report.findings.map((f) => [f.id, f.severity])).toEqual([["security-F1", "minor"]]);
  });

  it("starts a fix pass for a blockAt blocker reviewer only on a blocker", async () => {
    const reviewers = { reviewers: [code, { ...security, blockAt: "blocker" }] };
    const onMajor = await runReview({ "reviewer:security-r0": { attempts: [{ report: { findings: [major] } }] } }, { reviewers });
    expect(onMajor.result.exitCode).toBe(0);
    expect(fixers(onMajor.provider.calls)).toHaveLength(0);
    expect((await reportOf(onMajor.ctx.runDir, "security")).blockAt).toBe("blocker");
  });

  it("starts a fix pass for a blockAt blocker reviewer on a blocker", async () => {
    const reviewers = { reviewers: [code, { ...security, blockAt: "blocker" }] };
    const onBlocker = await runReview(
      { "reviewer:security-r0": { attempts: [{ report: { findings: [{ ...major, severity: "blocker" }] } }] } },
      { reviewers },
    );
    expect(onBlocker.result.exitCode).toBe(0);
    expect(fixers(onBlocker.provider.calls)).toHaveLength(1);
  });

  it("runs a reviewer with its own model and the others with the run's", async () => {
    const { result, reviewerCalls } = await runReview({}, { reviewers: { reviewers: [code, { ...security, provider: "fake", model: "m2" }] } });
    expect(result.exitCode).toBe(0);
    expect(reviewerCalls.find((c) => c.label === "security-r0")!.model).toBe("m2");
    expect(reviewerCalls.find((c) => c.label === "code-r0")!.model).toBeUndefined();
  });
});
