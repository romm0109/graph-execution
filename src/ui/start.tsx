import { render } from "ink";
import type { ChangeTracker } from "../runner/changes.js";
import type { RetryHub } from "../runner/retry-hub.js";
import { phaseLabel, type RunEmitter } from "../runner/events.js";
import { App, MOUSE_OFF } from "./App.js";
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
  /** The store the run already feeds; the Ink UI creates its own when omitted. */
  store?: RunStore;
  /** Set when the run waits for a retry after a failure (used by later slices' keys and buttons). */
  retry?: RetryHub;
  /** Serves diff text for the web UI's `GET /changes/<id>?file=`. */
  changes?: Pick<ChangeTracker, "fileDiff">;
  /** `.graph-execution/<run-id>` */
  runDir?: string;
  /** Called on Ctrl+C inside the Ink UI; defaults to sending SIGINT to this process. */
  onInterrupt?: () => void;
  /** Called by the web UI's Abort button; defaults to sending SIGINT to this process. */
  onAbort?: () => void;
}

export interface UiHandle {
  /**
   * The run's log: shown in the live view's events panel, without the agent output lines (those go to the log
   * files); printed as is in plain mode and once the UI is stopped.
   */
  log: (line: string) => void;
  /**
   * Draws the final frame, then unmounts the UI and restores the terminal; idempotent. Later `log` lines go straight
   * to the output.
   */
  stop: () => Promise<void>;
}

/** Agent output lines the agents' runners log as `[<label>] text`; they belong in the log files, not on screen. */
export const isAgentOutputLine = (line: string): boolean => /^\[[^\]\s][^\]]*\] /.test(line);

const time = (date = new Date()): string => date.toTimeString().slice(0, 8);

/** How long `stop` gives React and Ink to draw the final frame: a few of Ink's frames at its default 30 fps. */
const FINAL_FRAME_MS = 150;

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
  const store =
    opts.store ??
    new RunStore(opts.events, { taskIds: opts.layers.flat(), merged: opts.merged, attempts: opts.attempts });
  // patchConsole: Ink prints console lines above its live area instead of drawing over them.
  const instance = render(
    <App
      store={store}
      layers={opts.layers}
      parents={opts.parents}
      mergeTarget={opts.mergeTarget}
      logsDir={opts.logsDir}
      mouse
      runId={opts.runId}
      provider={opts.provider}
      startedAt={Date.now()}
      onRetry={(id) => void opts.retry?.retryNode(id)}
      onMerge={() => void opts.retry?.mergeNow()}
      onQuit={() => opts.retry?.quit()}
      onInterrupt={opts.onInterrupt ?? (() => process.kill(process.pid, "SIGINT"))}
    />,
    { stdout, ...(opts.stdin ? { stdin: opts.stdin } : {}), exitOnCtrlC: false, patchConsole: true },
  );
  let mounted = true;
  // Mouse reporting left on would make the shell print escape codes on every click after an unexpected exit.
  const mouseOff = (): void => void stdout.write(MOUSE_OFF);
  process.once("exit", mouseOff);
  return {
    log: (line) => {
      if (!mounted) print(line);
      else if (!isAgentOutputLine(line)) store.addEvent(line);
    },
    stop: async () => {
      if (!mounted) return;
      mounted = false;
      // The `run:end` update (the summary) is committed by React and drawn by Ink's throttled renderer
      // asynchronously; unmounting right away would leave the previous frame, without the summary, on screen.
      await new Promise((resolve) => setTimeout(resolve, FINAL_FRAME_MS));
      instance.unmount();
      instance.cleanup();
      if (!opts.store) store.dispose();
      process.off("exit", mouseOff);
      mouseOff();
    },
  };
}

const NODE_LABELS: Record<string, string> = {
  "@gate": "validation gate",
  "@gate-fixer": "validation fixer",
  "@reviewer": "code reviewer",
  "@tester": "live tester",
  "@fixer": "fixer",
  "@merge": "apply step",
};

function startPlain(opts: UiOptions, print: (line: string) => void): UiHandle {
  const say = (text: string): void => print(`[${time()}] ${text}`);
  const { events } = opts;
  if (opts.logsDir) say(`run ${opts.runId}: agent output goes to ${opts.logsDir}`);
  const off = [
    events.on("task:start", ({ taskId }) => say(`task ${taskId} running`)),
    events.on("task:retry", ({ taskId, attempt, attempts, reason }) =>
      say(`task ${taskId} retry ${attempt}/${attempts} (${reason.message})`),
    ),
    events.on("task:status", ({ taskId, status, round, rounds }) =>
      say(`task ${taskId} ${status}${round ? ` (fix round ${round}/${rounds ?? "?"})` : ""}`),
    ),
    events.on("task:merged", ({ taskId }) => say(`task ${taskId} merged`)),
    events.on("task:failed", ({ taskId }) => say(`task ${taskId} failed`)),
    events.on("phase:change", (change) => say(`phase ${phaseLabel(change)}`)),
    events.on("agent:start", ({ agent, label }) => say(`${AGENT_TITLE[agent]} running (${label})`)),
    events.on("agent:retry", ({ agent, attempt, attempts, reason }) =>
      say(`${AGENT_TITLE[agent]} retry ${attempt}/${attempts} (${reason.message})`),
    ),
    events.on("agent:status", ({ agent, status, round, rounds }) =>
      say(`${AGENT_TITLE[agent]} ${status}${round ? ` (fix round ${round}/${rounds ?? "?"})` : ""}`),
    ),
    events.on("agent:end", ({ agent, ok }) => say(`${AGENT_TITLE[agent]} ${ok ? "done" : "failed"}`)),
    events.on("merge:status", ({ status }) => {
      if (status !== "skipped") say(`merge into ${opts.mergeTarget ?? "the starting branch"} ${status}`);
    }),
    events.on("failure:info", ({ nodeId, summary }) => {
      if (summary.status !== "ready") return;
      const title = NODE_LABELS[nodeId] ?? (nodeId.startsWith("@") ? nodeId.slice(1) : `task ${nodeId}`);
      say(`${title} failed: ${summary.cause} (retry: ${summary.verdict})`);
    }),
    events.on("run:end", (end) => {
      print("");
      for (const line of summaryLines(end)) print(line);
    }),
  ];
  return {
    log: print,
    stop: async () => {
      for (const unsubscribe of off) unsubscribe();
    },
  };
}
