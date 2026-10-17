import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GraphError } from "./errors.js";
import { taskSchema, type Task } from "./task.js";

export { GraphError };

/** Reads every `*.json` file in `dir` (non-recursive, sorted by file name) as a task. */
export async function loadTasks(dir: string): Promise<Task[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new GraphError([`cannot read tasks directory ${dir}: ${(err as Error).message}`]);
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    throw new GraphError([`no task files found in ${dir}`]);
  }

  const tasks: Task[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      problems.push(`${file}: invalid JSON: ${(err as Error).message}`);
      continue;
    }
    const parsed = taskSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      problems.push(`${file}: invalid task: ${issues}`);
      continue;
    }
    tasks.push(parsed.data);
  }

  if (problems.length > 0) throw new GraphError(problems);
  return tasks;
}
