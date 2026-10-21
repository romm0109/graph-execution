import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraphError, loadTasks } from "./load.js";
import { loadTestPlan } from "./testPlan.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

describe("loadTestPlan", () => {
  it("returns undefined when there is no file", async () => {
    expect(await loadTestPlan(fixture("diamond"))).toBeUndefined();
  });

  it("loads a valid plan", async () => {
    expect((await loadTestPlan(fixture("plan-ok")))?.cases).toHaveLength(2);
  });

  it("reports an invalid plan", async () => {
    const err = await loadTestPlan(fixture("plan-bad")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).problems.join("\n")).toMatch(/test-plan\.json: invalid test plan: .*priority/);
  });

  it("reports duplicate ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ge-plan-"));
    try {
      const c = { id: "P1", title: "t", steps: ["s"], expected: "e", priority: "must" };
      await writeFile(path.join(dir, "test-plan.json"), JSON.stringify({ cases: [c, c] }));
      const err = await loadTestPlan(dir).catch((e: unknown) => e);
      expect((err as GraphError).problems).toEqual(['test-plan.json: duplicate case id "P1"']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ge-plan-"));
    try {
      await writeFile(path.join(dir, "test-plan.json"), "{nope");
      await expect(loadTestPlan(dir)).rejects.toThrow(/test-plan\.json: invalid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is not loaded as a task", async () => {
    const tasks = await loadTasks(fixture("plan-ok"));
    expect(tasks).toHaveLength(4);
  });
});
