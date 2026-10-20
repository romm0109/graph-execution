import { readLogTail, runFailureSummary } from "../agents/summarizer.js";
import { InterruptedError } from "../state/errors.js";
import type { Provider } from "../providers/types.js";
import { failedNodeIds, type RunStore } from "../ui/store.js";
import type { RunEmitter, RunEnd } from "./events.js";
import { AGENT_NODE, GATE_NODE, MERGE_NODE } from "./nodes.js";

export interface FailureSummaryOptions {
  events: RunEmitter;
  view: RunStore;
  provider: Provider;
  model?: string;
  runDir: string;
  logsDir: string;
  log: (line: string) => void;
  /** The display name of a node id, e.g. `task 2` or `code reviewer`. */
  title: (nodeId: string) => string;
  /** The text of a task node's task, when the node is a task. */
  taskContent?: (nodeId: string) => string | undefined;
}

const VERDICT_TEXT = {
  likely_to_work: "a retry is likely to work",
  unlikely_to_help: "a retry is unlikely to help",
  unclear: "it is unclear whether a retry will help",
};

/** A run that ended because of Ctrl+C or an external abort: nobody wants an explanation for that. */
export const isDeliberate = (end: RunEnd): boolean => end.abort !== undefined && /was interrupted$/.test(end.abort.message);

const AGENT_BY_NODE = Object.fromEntries(Object.entries(AGENT_NODE).map(([agent, id]) => [id, agent])) as Record<
  string,
  keyof typeof AGENT_NODE
>;

/**
 * Starts the background failure summaries (PRD): one provider call per failed node, with the run's provider and model.
 * The result goes out as `failure:info` events; nothing here ever affects the run. `drain()` waits for the calls under
 * way, `stop()` cancels them.
 */
export function startFailureSummaries(opts: FailureSummaryOptions): { stop(): void; drain(): Promise<void> } {
  const { events, view, log } = opts;
  const controller = new AbortController();
  const registered = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  /** Per node id: the failed attempts so far and the last failure message. */
  const history = new Map<string, string[]>();
  const lastMessage = new Map<string, string>();

  const note = (nodeId: string, attempt: number, attempts: number, message: string): void => {
    lastMessage.set(nodeId, message);
    const lines = history.get(nodeId) ?? [];
    lines.push(`attempt ${attempt - 1} of ${attempts} failed: ${message}`);
    history.set(nodeId, lines);
  };

  const labelOf = (nodeId: string): string => {
    const state = view.getState();
    if (nodeId === GATE_NODE) return state.gate.label;
    if (nodeId === MERGE_NODE) return state.merge.label;
    const agent = AGENT_BY_NODE[nodeId];
    return agent ? state.agents[agent].label : (state.nodes[nodeId]?.label ?? nodeId);
  };

  const register = (nodeId: string, error: string): void => {
    if (registered.has(nodeId) || controller.signal.aborted) return;
    registered.add(nodeId);
    const title = opts.title(nodeId);
    const work = (async (): Promise<void> => {
      events.emit("failure:info", { nodeId, error, summary: { status: "pending" } });
      const label = labelOf(nodeId);
      const result = await runFailureSummary({
        provider: opts.provider,
        model: opts.model,
        runDir: opts.runDir,
        nodeId,
        label,
        title,
        kind: nodeId.startsWith("@") ? "pipeline step" : "task",
        error,
        taskContent: opts.taskContent?.(nodeId),
        attempts: history.get(nodeId) ?? [],
        logTail: await readLogTail(opts.logsDir, label).catch(() => ""),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result) {
        events.emit("failure:info", { nodeId, error, summary: { status: "ready", ...result } });
        log(`${title} failed: ${result.cause} Retry: ${VERDICT_TEXT[result.verdict]}`);
      } else {
        events.emit("failure:info", { nodeId, error, summary: { status: "unavailable" } });
        log(`could not summarize the failure of ${title}`);
      }
    })().catch(() => undefined);
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  // Deliberate interruptions (Ctrl+C, web Abort) kill tasks with an `InterruptedError`: not a failure to explain.
  const interrupted = (error: unknown): boolean => error instanceof InterruptedError;

  const off = [
    events.on("task:retry", ({ taskId, attempt, attempts, reason }) => note(taskId, attempt, attempts, reason.message)),
    events.on("agent:retry", ({ agent, attempt, attempts, reason }) =>
      note(AGENT_NODE[agent], attempt, attempts, reason.message),
    ),
    events.on("task:failed", ({ taskId, error }) => {
      if (interrupted(error)) return;
      register(taskId, error instanceof Error ? error.message : String(error));
    }),
    events.on("agent:end", ({ agent, ok }) => {
      if (!ok) register(AGENT_NODE[agent], lastMessage.get(AGENT_NODE[agent]) ?? "the agent failed");
    }),
    events.on("run:restart", () => {
      registered.clear();
      history.clear();
      lastMessage.clear();
    }),
    events.on("run:end", (end) => {
      if (isDeliberate(end)) return controller.abort();
      for (const nodeId of failedNodeIds(view.getState())) {
        if (registered.has(nodeId)) continue;
        const error = nodeId === MERGE_NODE ? end.merge?.reason : undefined;
        register(nodeId, error ?? end.abort?.message ?? lastMessage.get(nodeId) ?? "the step failed");
      }
    }),
  ];

  return {
    stop: () => {
      for (const unsubscribe of off) unsubscribe();
      controller.abort();
    },
    drain: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
