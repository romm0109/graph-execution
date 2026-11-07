/** Raised when the task folder or the task graph is invalid. Carries every problem found. */
export class GraphError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.length === 1 ? problems[0] : `Invalid task graph:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "GraphError";
    this.problems = problems;
  }
}
