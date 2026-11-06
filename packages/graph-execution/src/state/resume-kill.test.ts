import { describe, expect, it } from "vitest";
import { FULL_FLOW, start, onlyRun, readCalls, tree, withRepo, killAndResume } from "../__fixtures__/resume.js";

describe("resume", () => {
  it("finishes a run killed at any state save with the uninterrupted run's tree", async () => {
    const expectedTree = await withRepo(FULL_FLOW.config, FULL_FLOW.script, async (repo) => {
      const res = await start(repo);
      expect(res.exitCode, res.stdout).toBe(0);
      const { runId } = await onlyRun(repo);
      const calls = await readCalls(repo);
      // The flow really covers a fix pass and a re-review.
      expect(calls).toEqual(expect.arrayContaining(["fixer:fix-r1", "reviewer:code-r1", "tester:tester-r1"]));
      return tree(repo, runId);
    });

    const BATCH = 6;
    let tested = 0;
    for (let first = 1; ; first += BATCH) {
      const results = await Promise.all(
        Array.from({ length: BATCH }, (_, i) => killAndResume(first + i, expectedTree)),
      );
      tested += results.filter(Boolean).length;
      if (results.includes(false)) break;
    }
    // Sanity check: the flow has many transitions, each of them was a kill point.
    expect(tested).toBeGreaterThan(20);
  }, 600_000);
});
