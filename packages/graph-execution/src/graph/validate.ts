import { GraphError } from "./errors.js";
import type { Task } from "./task.js";

/** Orders ids naturally ("2" before "10"), falling back to code-unit order for ties like "01"/"1". */
export const byId = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

/** Throws a GraphError listing every problem: duplicate ids, unknown/self dependencies, and a cycle. */
export function validateGraph(tasks: Task[]): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) duplicates.add(task.id);
    ids.add(task.id);
  }
  for (const id of [...duplicates].sort(byId)) problems.push(`duplicate task id "${id}"`);

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (dep === task.id) problems.push(`task "${task.id}" depends on itself`);
      else if (!ids.has(dep)) problems.push(`task "${task.id}" depends on unknown task "${dep}"`);
    }
  }

  const cycle = findCycle(tasks, ids);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);

  if (problems.length > 0) throw new GraphError(problems);
}

/** DFS over known, non-self edges; returns one cycle as `[a, b, c, a]`, or null. */
function findCycle(tasks: Task[], ids: Set<string>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const task of tasks) {
    const deps = task.dependencies.filter((d) => d !== task.id && ids.has(d));
    edges.set(task.id, [...(edges.get(task.id) ?? []), ...deps]);
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of [...(edges.get(id) ?? [])].sort(byId)) {
      const s = state.get(next);
      if (s === "visiting") return [...stack.slice(stack.indexOf(next)), next];
      if (s === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of [...edges.keys()].sort(byId)) {
    if (state.get(id) === undefined) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Groups tasks into layers so every task's dependencies sit in earlier layers (Kahn's algorithm).
 * Each layer is sorted by id. Expects a graph that passed validateGraph.
 */
export function executionLayers(tasks: Task[]): Task[][] {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependencies)]));
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const layers: Task[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort(byId);
    if (ready.length === 0) throw new GraphError(["dependency cycle detected"]);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
    layers.push(ready.map((id) => tasksById.get(id)!));
  }
  return layers;
}
