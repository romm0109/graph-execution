import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { GraphError, loadTasks } from "../graph/load.js";
import { executionLayers, validateGraph } from "../graph/validate.js";

// The shipped skills/to-tasks/validate-tasks.mjs must accept and reject exactly what the tool does.
// The test lives here, not in skills/to-tasks/, because that folder is copied verbatim into users' projects.
const root = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(root, "skills", "to-tasks", "validate-tasks.mjs");
const fixture = (name: string): string => path.join(root, "src", "__fixtures__", name);

type Category = "json" | "shape" | "duplicate" | "self" | "unknown" | "cycle" | "empty";

function categoryOf(problem: string): Category {
  if (problem.includes("invalid JSON")) return "json";
  if (problem.includes("invalid task")) return "shape";
  if (problem.includes("duplicate task id")) return "duplicate";
  if (problem.includes("depends on itself")) return "self";
  if (problem.includes("depends on unknown task")) return "unknown";
  if (problem.includes("dependency cycle")) return "cycle";
  if (problem.includes("no task files found")) return "empty";
  throw new Error(`uncategorized problem: ${problem}`);
}

/** Problems per category. Shape problems count files, since the tool reports one line per invalid file. */
function tally(problems: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const shapeFiles = new Set<string>();
  for (const p of problems) {
    const category = categoryOf(p);
    if (category === "shape") shapeFiles.add(p.split(":")[0]!);
    else counts[category] = (counts[category] ?? 0) + 1;
  }
  if (shapeFiles.size > 0) counts.shape = shapeFiles.size;
  return counts;
}

async function toolVerdict(dir: string): Promise<{ ok: true; summary: string } | { ok: false; counts: Record<string, number> }> {
  try {
    const tasks = await loadTasks(dir);
    validateGraph(tasks);
    return { ok: true, summary: `OK: ${tasks.length} tasks, ${executionLayers(tasks).length} layers` };
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;
    return { ok: false, counts: tally(err.problems) };
  }
}

async function scriptVerdict(dir: string): Promise<{ ok: true; summary: string } | { ok: false; counts: Record<string, number> }> {
  const res = await execa("node", [script, dir], { reject: false });
  if (res.exitCode === 0) return { ok: true, summary: res.stdout.trim() };
  expect(res.exitCode).toBe(1);
  const [header, ...problems] = res.stderr.trim().split("\n");
  expect(header).toBe(`${problems.length} problem(s) in ${dir}:`);
  return { ok: false, counts: tally(problems) };
}

describe("validate-tasks.mjs agrees with validateGraph", () => {
  const cases: [string, Record<string, number> | "ok"][] = [
    ["diamond", "ok"],
    ["cycle", { cycle: 1 }],
    ["invalid-mix", { duplicate: 1, self: 1, unknown: 1 }],
    ["bad-json", { json: 1 }],
    ["bad-types", { shape: 7 }],
    ["empty", { empty: 1 }],
  ];

  it.each(cases)("%s", async (name, expected) => {
    const dir = fixture(name);
    const [tool, standalone] = await Promise.all([toolVerdict(dir), scriptVerdict(dir)]);
    expect(standalone).toEqual(tool);
    if (expected === "ok") expect(tool.ok).toBe(true);
    else expect(tool).toEqual({ ok: false, counts: expected });
  });
});
