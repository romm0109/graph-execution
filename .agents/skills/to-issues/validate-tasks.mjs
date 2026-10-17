#!/usr/bin/env node
// Standalone validator for a graph-execution task folder. No dependencies: it is copied into projects as-is.
// Applies the same rules as graph-execution itself (src/graph/load.ts, task.ts, validate.ts).
// Usage: node validate-tasks.mjs <tasks-dir>
import fs from "node:fs";
import path from "node:path";

/** Orders ids naturally ("2" before "10"), falling back to code-unit order for ties like "01"/"1". */
const byId = (a, b) => a.localeCompare(b, "en", { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Schema problems of one parsed file, mirroring the zod task schema. */
function shapeProblems(json) {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return ["not a JSON object"];
  const problems = [];
  if (typeof json.id !== "string" || json.id.length === 0) problems.push(`"id" must be a non-empty string`);
  if (typeof json.content !== "string" || json.content.length === 0) {
    problems.push(`"content" must be a non-empty string`);
  }
  if (json.dependencies !== undefined && !isStringArray(json.dependencies)) {
    problems.push(`"dependencies" must be an array of strings`);
  }
  if (json.validate !== undefined && json.validate !== null && json.validate !== false && !isStringArray(json.validate)) {
    problems.push(`"validate" must be an array of strings, false or null`);
  }
  return problems;
}

/** Reads and checks every file; returns the tasks and the per-file problems. */
function loadTasks(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { tasks: [], problems: [`cannot read tasks directory ${dir}: ${err.message}`] };
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) return { tasks: [], problems: [`no task files found in ${dir}`] };

  const tasks = [];
  const problems = [];
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: invalid JSON: ${err.message}`);
      continue;
    }
    const shape = shapeProblems(json);
    if (shape.length > 0) {
      for (const p of shape) problems.push(`${file}: invalid task: ${p}`);
      continue;
    }
    tasks.push({ file, id: json.id, dependencies: json.dependencies ?? [] });
  }
  return { tasks, problems };
}

/** Duplicate ids, unknown and self dependencies, and one cycle. */
function graphProblems(tasks) {
  const problems = [];
  const ids = new Set();
  const duplicates = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) duplicates.add(task.id);
    ids.add(task.id);
  }
  for (const id of [...duplicates].sort(byId)) {
    const files = tasks.filter((t) => t.id === id).map((t) => t.file);
    problems.push(`${files.join(", ")}: duplicate task id "${id}"`);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (dep === task.id) problems.push(`${task.file}: task "${task.id}" depends on itself`);
      else if (!ids.has(dep)) problems.push(`${task.file}: task "${task.id}" depends on unknown task "${dep}"`);
    }
  }
  const cycle = findCycle(tasks, ids);
  if (cycle) {
    const files = [...new Set(cycle.map((id) => tasks.find((t) => t.id === id).file))];
    problems.push(`${files.join(", ")}: dependency cycle: ${cycle.join(" -> ")}`);
  }
  return problems;
}

/** DFS over known, non-self edges; returns one cycle as `[a, b, c, a]`, or null. */
function findCycle(tasks, ids) {
  const edges = new Map();
  for (const task of tasks) {
    const deps = task.dependencies.filter((d) => d !== task.id && ids.has(d));
    edges.set(task.id, [...(edges.get(task.id) ?? []), ...deps]);
  }
  const state = new Map();
  const stack = [];
  const visit = (id) => {
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

/** Number of layers when every task runs after its dependencies (Kahn's algorithm). */
function countLayers(tasks) {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependencies)]));
  let layers = 0;
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((id) => remaining.get(id).size === 0);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
    layers++;
  }
  return layers;
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node validate-tasks.mjs <tasks-dir>");
  process.exit(1);
}

// Like graph-execution, graph rules only run once every file has a valid shape.
const { tasks, problems } = loadTasks(dir);
if (problems.length === 0) problems.push(...graphProblems(tasks));

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in ${dir}:`);
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`OK: ${tasks.length} tasks, ${countLayers(tasks)} layers`);
