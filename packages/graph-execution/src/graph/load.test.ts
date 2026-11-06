import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraphError, loadTasks } from "./load.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

describe("loadTasks", () => {
  it("loads every task file sorted by file name", async () => {
    const tasks = await loadTasks(fixture("diamond"));
    expect(tasks.map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
    expect(tasks.map((t) => t.validate)).toEqual([undefined, ["node --version"], false, null]);
  });

  it("rejects invalid JSON naming the file", async () => {
    await expect(loadTasks(fixture("bad-json"))).rejects.toThrow(/1\.json: invalid JSON/);
  });

  it("rejects an empty folder", async () => {
    await expect(loadTasks(fixture("empty"))).rejects.toThrow(GraphError);
    await expect(loadTasks(fixture("empty"))).rejects.toThrow(/no task files found/);
  });

  it("rejects a missing folder", async () => {
    await expect(loadTasks(fixture("does-not-exist"))).rejects.toThrow(/cannot read tasks directory/);
  });
});
