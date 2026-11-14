// How graph-manager starts the graph-execution engine (used by host/local.ts; re-exported from routes/runs.ts).

export const START_TIMEOUT_MS = 120_000;
/** Internal variables that would tie a new run to another run's folder or launcher. */
export const INTERNAL_ENV = ["GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE", "GRAPH_EXECUTION_TASK_NAME"];

/** The graph-execution command line: `node <cli.js> …` for a `.js` bin, else the bin itself. */
export function engineCommand(bin: string, args: string[]): { file: string; args: string[] } {
  return /\.[cm]?js$/.test(bin) ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

export const lastLines = (text: string, n: number): string => text.trimEnd().split("\n").slice(-n).join("\n");
