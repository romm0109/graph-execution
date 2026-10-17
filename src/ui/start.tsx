import { render } from "ink";
import { phaseLabel, type RunEmitter } from "../runner/events.js";
import { App } from "./App.js";
import { AGENT_TITLE } from "./Graph.js";
import { RunStore } from "./store.js";
import { summaryLines } from "./Summary.js";

export interface UiOptions {
  events: RunEmitter;
  /** Task ids per execution layer. */
  layers: string[][];
  /** Dependencies per task id, drawn as the graph's arrows. */
  parents?: Record<string, readonly string[]>;
  /** The branch the result is merged into once the review is clean; none with `--no-merge` or a detached HEAD. */
  mergeTarget?: string;
  /** Tasks already merged before this run (a resume). */
  merged?: readonly string[];
  /** Attempt budget per task, for `retry N/M`. */
  attempts: number;
  runId: string;
  provider: string;
  /** Where the agents' full output goes, announced in plain mode. */
  logsDir?: string;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** Plain mode's output; defaults to writing lines to `stdout`. */
  print?: (line: string) => void;
  /** Called on Ctrl+C inside the Ink UI; defaults to sending SIGINT to this process. */
  onInterrupt?: () => void;
}

export interface UiHandle {
  /**
   * The run's log: shown above the live view, without the agent output lines the log tail shows; printed as is in
   * plain mode.
   */
  log: (line: string) => void;
  /** Unmounts the UI and restores the terminal; idempotent. Later `log` lines go straight to the output. */
  stop: () => void;
}

/** Agent output lines the agents' runners log as `[<label>] text`; the UI shows them in the tail and the log files. */
export const isAgentOutputLine = (line: string): boolean => /^\[[^\]\s][^\]]*\] /.test(line);

const time = (date = new Date()): string => date.toTimeString().slice(0, 8);

/**
 * Starts the terminal UI for a run (PRD §7.9): Ink when stdout is a TTY, otherwise a plain subscriber printing one
 * line per event, without escape codes, and the final summary at `run:end`.
 */
export function startUi(opts: UiOptions): UiHandle {
  const stdout = opts.stdout ?? process.stdout;
  const print = opts.print ?? ((line: string) => void stdout.write(`${line}\n`));
  return stdout.isTTY ? startInk(opts, stdout, print) : startPlain(opts, print);
}

function startInk(opts: UiOptions, stdout: NodeJS.WriteStream, print: (line: string) => void): UiHandle {
  const store = new RunStore(opts.events, {
    taskIds: opts.layers.flat(),
    merged: opts.merged,
    attempts: opts.attempts,
  });
  // patchConsole: Ink prints console lines above its live area instead of drawing over them.
  const instance = render(
    <App
      store={store}
      layers={opts.layers}
      parents={opts.parents}
      mergeTarget={opts.mergeTarget}
      runId={opts.runId}
      provider={opts.provider}
      startedAt={Date.now()}
      onInterrupt={opts.onInterrupt ?? (() => process.kill(process.pid, "SIGINT"))}
    />,
    { stdout, ...(opts.stdin ? { stdin: opts.stdin } : {}), exitOnCtrlC: false, patchConsole: true },
  );
  let mounted = true;
  return {
    log: (line) => {
      if (!mounted) print(line);
      else if (!isAgentOutputLine(line)) console.log(line);
    },
    stop: () => {
      if (!mounted) return;
      mounted = false;
      instance.unmount();
      instance.cleanup();
      store.dispose();
    },
  };
}

function startPlain(opts: UiOptions, print: (line: string) => void): UiHandle {
  const say = (text: string): void => print(`[${time()}] ${text}`);
  const { events } = opts;
  if (opts.logsDir) say(`run ${opts.runId}: agent output goes to ${opts.logsDir}`);
  const off = [
    events.on("task:start", ({ taskId }) => say(`task ${taskId} running`)),
    events.on("task:retry", ({ taskId, attempt, attempts, reason }) =>
      say(`task ${taskId} retry ${attempt}/${attempts} (${reason.message})`),
    ),
    events.on("task:status", ({ taskId, status }) => say(`task ${taskId} ${status}`)),
    events.on("task:merged", ({ taskId }) => say(`task ${taskId} merged`)),
    events.on("task:failed", ({ taskId }) => say(`task ${taskId} failed`)),
    events.on("phase:change", (change) => say(`phase ${phaseLabel(change)}`)),
    events.on("agent:start", ({ agent, label }) => say(`${AGENT_TITLE[agent]} running (${label})`)),
    events.on("agent:retry", ({ agent, attempt, attempts, reason }) =>
      say(`${AGENT_TITLE[agent]} retry ${attempt}/${attempts} (${reason.message})`),
    ),
    events.on("agent:status", ({ agent, status }) => say(`${AGENT_TITLE[agent]} ${status}`)),
    events.on("agent:end", ({ agent, ok }) => say(`${AGENT_TITLE[agent]} ${ok ? "done" : "failed"}`)),
    events.on("merge:status", ({ status }) => {
      if (status !== "skipped") say(`merge into ${opts.mergeTarget ?? "the starting branch"} ${status}`);
    }),
    events.on("run:end", (end) => {
      print("");
      for (const line of summaryLines(end)) print(line);
    }),
  ];
  return {
    log: print,
    stop: () => {
      for (const unsubscribe of off) unsubscribe();
    },
  };
}
