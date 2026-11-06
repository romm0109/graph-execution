import { describe, expect, it } from "vitest";
import { GraphError } from "./errors.js";
import { taskSchema, type Task } from "./task.js";
import { executionLayers, validateGraph } from "./validate.js";

const task = (id: string, dependencies: string[] = []): Task => ({ id, content: `task ${id}`, dependencies });

function problemsOf(tasks: Task[]): string[] {
  try {
    validateGraph(tasks);
  } catch (err) {
    expect(err).toBeInstanceOf(GraphError);
    return (err as GraphError).problems;
  }
  return [];
}

describe("validateGraph", () => {
  it("accepts a valid diamond", () => {
    expect(problemsOf([task("1"), task("2", ["1"]), task("3", ["1"]), task("4", ["2", "3"])])).toEqual([]);
  });

  it("reports duplicate ids", () => {
    expect(problemsOf([task("1"), task("1")])).toEqual(['duplicate task id "1"']);
  });

  it("reports unknown dependencies", () => {
    expect(problemsOf([task("1", ["9"])])).toEqual(['task "1" depends on unknown task "9"']);
  });

  it("reports self-dependency", () => {
    expect(problemsOf([task("1", ["1"])])).toEqual(['task "1" depends on itself']);
  });

  it("reports a 3-node cycle as a -> b -> c -> a", () => {
    expect(problemsOf([task("a", ["b"]), task("b", ["c"]), task("c", ["a"])])).toEqual([
      "dependency cycle: a -> b -> c -> a",
    ]);
  });

  it("reports all problems together", () => {
    const problems = problemsOf([task("1", ["1"]), task("2", ["missing"]), task("2"), task("x", ["y"]), task("y", ["x"])]);
    expect(problems).toEqual([
      'duplicate task id "2"',
      'task "1" depends on itself',
      'task "2" depends on unknown task "missing"',
      "dependency cycle: x -> y -> x",
    ]);
  });
});

describe("executionLayers", () => {
  const ids = (layers: Task[][]): string[][] => layers.map((l) => l.map((t) => t.id));

  it("layers a diamond as [[1],[2,3],[4]]", () => {
    const tasks = [task("4", ["2", "3"]), task("3", ["1"]), task("2", ["1"]), task("1")];
    expect(ids(executionLayers(tasks))).toEqual([["1"], ["2", "3"], ["4"]]);
  });

  it("orders ids within a layer naturally", () => {
    expect(ids(executionLayers([task("10"), task("2"), task("1")]))).toEqual([["1", "2", "10"]]);
  });
});

describe("taskSchema", () => {
  const base = { id: "1", content: "do it" };

  it.each([[["npm test"]], [false], [null], [undefined]])("accepts validate = %j", (validate) => {
    expect(taskSchema.safeParse({ ...base, validate }).success).toBe(true);
  });

  it("rejects validate = true", () => {
    expect(taskSchema.safeParse({ ...base, validate: true }).success).toBe(false);
  });

  it("defaults dependencies to [] and keeps ids as strings", () => {
    expect(taskSchema.parse(base)).toEqual({ id: "1", content: "do it", dependencies: [] });
    expect(taskSchema.safeParse({ ...base, id: 1 }).success).toBe(false);
  });
});
