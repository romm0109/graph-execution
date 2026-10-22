import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testCaseSchema } from "../graph/testPlan.js";
import { allComments, commentOutcomes, fixerCommentsPath, commentFindings, commentSchema, liveCheckCases, withLiveChecks, openComments, HumanReviewError, HumanReviewStore, parseSuggestion, humanRoundPath, loadHumanRound, startHumanRound } from "./human.js";

const setup = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "human-"));
  await startHumanRound(dir, 1, "base", "head");
  return { dir, store: new HumanReviewStore(dir) };
};

describe("HumanReviewStore", () => {
  it("numbers ids per round and keeps earlier rounds read-only", async () => {
    const { dir, store } = await setup();
    const a = await store.add({ body: "one" });
    const b = await store.add({ body: "two", file: "a.ts", line: 3, snippet: "x", liveCheck: true });
    expect([a.id, b.id]).toEqual(["H1-1", "H1-2"]);
    expect(b.liveCheck).toBe(true);
    await startHumanRound(dir, 2, "head", "head2");
    expect((await store.add({ body: "three" })).id).toBe("H2-1");
    await expect(store.edit("H1-1", { body: "x" })).rejects.toBeInstanceOf(HumanReviewError);
    await expect(store.remove("H1-2")).rejects.toThrow(/earlier round/);
    await expect(store.remove("H2-9")).rejects.toMatchObject({ kind: "unknown" });
    expect((await allComments(dir, 2)).map((c) => c.id)).toEqual(["H1-1", "H1-2", "H2-1"]);
  });

  it("edits, deletes and persists before resolving", async () => {
    const { dir, store } = await setup();
    const c = await store.add({ body: "one" });
    await store.edit(c.id, { body: "changed", liveCheck: true });
    const onDisk = JSON.parse(await readFile(humanRoundPath(dir, 1), "utf8"));
    expect(onDisk.comments[0]).toMatchObject({ body: "changed", liveCheck: true });
    expect(await loadHumanRound(dir, 1)).toEqual(await new HumanReviewStore(dir).current());
    await store.remove(c.id);
    expect((await loadHumanRound(dir, 1))?.comments).toEqual([]);
  });

  it("rejects an empty body and a line without file", async () => {
    const { store } = await setup();
    await expect(store.add({ body: "  " })).rejects.toBeInstanceOf(HumanReviewError);
    await expect(store.add({ body: "x", line: 2 })).rejects.toBeInstanceOf(HumanReviewError);
  });

  it("gives concurrent adds distinct ids; startHumanRound keeps an existing file", async () => {
    const { dir, store } = await setup();
    const all = await Promise.all([1, 2, 3, 4, 5].map((n) => store.add({ body: `c${n}` })));
    expect(new Set(all.map((c) => c.id)).size).toBe(5);
    expect((await startHumanRound(dir, 1, "other", "other")).comments).toHaveLength(5);
  });
});

describe("commentFindings", () => {
  const base = { round: 1, liveCheck: false, followUps: [] as string[] };
  it("turns open and reopened comments into blockers, leaving resolved ones out", () => {
    const found = commentFindings([
      { ...base, id: "H1-1", body: "General", status: "open" },
      { ...base, id: "H1-2", body: "Line", file: "a.ts", side: "new" as const, startLine: 4, endLine: 4, snippet: "x()", status: "reopened", followUps: ["Still wrong"] },
      { ...base, id: "H1-3", body: "Done", status: "resolved" },
    ]);
    expect(found.map((f) => f.id)).toEqual(["human-H1-1", "human-H1-2"]);
    expect(found[0]).toMatchObject({ severity: "blocker", failureScenario: "general comment on the whole change" });
    expect(found[1]).toMatchObject({ file: "a.ts", line: 4, endLine: 4, side: "new", failureScenario: "a.ts new L4\nx()" });
    expect(found[1]!.description).toBe("Line\n\nFollow-up: Still wrong");
    expect(openComments([{ ...base, id: "H1-3", body: "Done", status: "resolved" }])).toEqual([]);
  });
});

describe("liveCheckCases", () => {
  const base = { round: 1, liveCheck: true, followUps: [] as string[], status: "open" as const };
  it("keeps only open liveCheck comments, with follow-ups in expected", () => {
    const cases = liveCheckCases([
      { ...base, id: "H1-1", body: "Check paging\nmore", file: "a.ts", startLine: 3, endLine: 3, followUps: ["Still 500"], status: "reopened" },
      { ...base, id: "H1-2", body: "Resolved", status: "resolved" },
      { ...base, id: "H1-3", body: "Plain", liveCheck: false },
    ]);
    expect(cases.map((c) => c.id)).toEqual(["H1-1"]);
    expect(cases[0]!.title).toBe("Check paging");
    expect(cases[0]!.expected).toBe("Check paging\nmore / Still 500");
    expect(testCaseSchema.parse(cases[0])).toMatchObject({ priority: "must" });
  });

  it("combines with a plan; a plan case wins an id collision; empty is undefined", () => {
    const mk = (id: string) => ({ id, title: "t", steps: ["s"], expected: "e", priority: "must" as const });
    expect(withLiveChecks(undefined, [])).toBeUndefined();
    expect(withLiveChecks(undefined, [mk("H1-1")])?.cases).toHaveLength(1);
    const plan = { cases: [{ ...mk("H1-1"), title: "plan" }, mk("P1")] };
    expect(withLiveChecks(plan, [mk("H1-1"), mk("H1-2")])?.cases.map((c) => `${c.id}:${c.title}`)).toEqual(["H1-1:plan", "P1:t", "H1-2:t"]);
    expect(withLiveChecks(plan, [])).toBe(plan);
  });
});

describe("resolve, reopen and outcomes", () => {
  const twoRounds = async () => {
    const { dir, store } = await setup();
    await store.add({ body: "one", liveCheck: true });
    await store.add({ body: "two" });
    await startHumanRound(dir, 2, "head", "head2");
    await store.add({ body: "now" });
    return { dir, store };
  };

  it("persists resolve and reopen in the comment's own round file", async () => {
    const { dir, store } = await twoRounds();
    expect((await store.resolve("H1-1")).status).toBe("resolved");
    expect(openComments(await allComments(dir, 2)).map((c) => c.id)).toEqual(["H1-2", "H2-1"]);
    const again = await store.reopen("H1-1", "  still wrong ");
    expect(again).toMatchObject({ status: "reopened", followUps: ["still wrong"] });
    await store.reopen("H1-1", "   ");
    expect((await loadHumanRound(dir, 1))?.comments[0]).toMatchObject({ status: "reopened", followUps: ["still wrong"] });
    expect(openComments(await allComments(dir, 2)).map((c) => c.id)).toContain("H1-1");
    expect((await loadHumanRound(dir, 2))?.comments).toHaveLength(1);
  });

  it("rejects unknown ids and current-round comments", async () => {
    const { store } = await twoRounds();
    await expect(store.resolve("H1-9")).rejects.toMatchObject({ kind: "unknown" });
    await expect(store.reopen("H7-1")).rejects.toMatchObject({ kind: "unknown" });
    await expect(store.resolve("H2-1")).rejects.toThrow(/edit or delete/);
  });

  it("merges note, verdict and live-check verdict; missing files give nothing", async () => {
    const { dir } = await twoRounds();
    const comments = await allComments(dir, 2);
    expect(await commentOutcomes(dir, 2, comments)).toEqual({});
    await mkdir(path.dirname(fixerCommentsPath(dir, 2)), { recursive: true });
    await writeFile(fixerCommentsPath(dir, 2), JSON.stringify([{ id: "H1-1", note: "renamed" }]));
    const report = (reviewer: string, extra: object) => JSON.stringify({ round: 2, reviewer, findings: [], ...extra });
    await writeFile(path.join(dir, "reports", "round2", "code.json"), report("code", { comments: [{ id: "H1-1", verdict: "addressed", evidence: "ok" }] }));
    await writeFile(path.join(dir, "reports", "round2", "tester.json"), report("tester", { cases: [{ id: "H1-1", verdict: "pass", evidence: "ran" }] }));
    const out = await commentOutcomes(dir, 2, comments);
    expect(out["H1-1"]).toEqual({ fixerNote: "renamed", verdict: "addressed", evidence: "ok", liveCheck: { verdict: "pass", evidence: "ran" } });
    expect(out["H1-2"]).toBeUndefined();
  });
});

describe("line ranges", () => {
  const raw = { id: "H1-1", round: 1, body: "b" };
  it("normalizes a legacy line to a one-line new-side range", () => {
    const c = commentSchema.parse({ ...raw, file: "a.ts", line: 4 });
    expect(c).toMatchObject({ side: "new", startLine: 4, endLine: 4 });
    expect("line" in c).toBe(false);
  });

  it("normalizes a legacy round file on load", async () => {
    const { dir } = await setup();
    const file = humanRoundPath(dir, 1);
    await writeFile(file, JSON.stringify({ round: 1, diffBase: "b", diffHead: "h", comments: [{ ...raw, file: "a.ts", line: 4 }] }));
    const loaded = await loadHumanRound(dir, 1);
    expect(loaded!.comments[0]).toMatchObject({ side: "new", startLine: 4, endLine: 4 });
    expect("line" in loaded!.comments[0]!).toBe(false);
  });

  it("saves an old-side range and rejects bad ranges", async () => {
    const { store } = await setup();
    const c = await store.add({ file: "a.ts", side: "old", startLine: 40, endLine: 42, snippet: "s", body: "x" });
    expect(c).toMatchObject({ side: "old", startLine: 40, endLine: 42 });
    await expect(store.add({ file: "a.ts", startLine: 3, endLine: 2, body: "x" })).rejects.toThrow("endLine before startLine");
    await expect(store.add({ file: "a.ts", startLine: 1, endLine: 502, body: "x" })).rejects.toThrow("range too long");
    await expect(store.add({ startLine: 3, body: "x" })).rejects.toThrow("line needs a file");
  });

  it("shows the range in findings and live-check steps", () => {
    const base = { round: 1, liveCheck: true, followUps: [] as string[], status: "open" as const };
    const cs = [
      { ...base, id: "H1-1", body: "a", file: "a.ts", side: "new" as const, startLine: 12, endLine: 18, snippet: "x()" },
      { ...base, id: "H1-2", body: "b", file: "a.ts", side: "old" as const, startLine: 40, endLine: 40, snippet: "y" },
    ];
    const found = commentFindings(cs);
    expect(found[0]).toMatchObject({ line: 12, endLine: 18, side: "new", failureScenario: "a.ts new L12–L18\nx()" });
    expect(found[1]).toMatchObject({ side: "old", failureScenario: "a.ts old L40\ny" });
    expect(liveCheckCases(cs)[0]!.steps[1]).toBe("Exercise the behavior of a.ts around new L12–L18");
  });
});

describe("suggestions", () => {
  const block = (t: string) => "```suggestion\n" + t + "\n```";
  it("parses suggestion blocks", () => {
    expect(parseSuggestion("no block")).toBeUndefined();
    expect(parseSuggestion(block("a\nb"))).toBe("a\nb");
    expect(parseSuggestion("```suggestion\r\na\r\nb\r\n```")).toBe("a\r\nb");
    expect(parseSuggestion("```suggestion\n```")).toBe("");
    expect(parseSuggestion("```suggestion\na\nb")).toBeUndefined();
    expect(parseSuggestion("Use this.\n\n" + block("x") + "\nThanks")).toBe("x");
  });

  it("allows a suggestion only on a new-side range", async () => {
    const { store } = await setup();
    await expect(store.add({ file: "a.ts", side: "old", startLine: 1, body: block("x") })).rejects.toThrow("suggestion needs side new");
    await expect(store.add({ file: "a.ts", body: block("x") })).rejects.toThrow("suggestion needs side new");
    await expect(store.add({ file: "a.ts", side: "new", startLine: 1, body: block("x") })).resolves.toMatchObject({ id: "H1-1" });
    const old = await store.add({ file: "a.ts", side: "old", startLine: 1, snippet: "s", body: "plain" });
    await expect(store.edit(old.id, { body: block("x") })).rejects.toThrow("suggestion needs side new");
  });
});
