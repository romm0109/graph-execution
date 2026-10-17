import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { renderGraph } from "./Graph.js";
import { PhaseBar } from "./PhaseBar.js";
import { Summary } from "./Summary.js";
import type { RunStore, ViewState } from "./store.js";
import { mix, THEME } from "./theme.js";

export interface AppProps {
  store: RunStore;
  layers: string[][];
  /** Dependencies per task id, for the graph's edges. */
  parents?: Record<string, readonly string[]>;
  runId: string;
  provider: string;
  /** The branch the result is merged into once the review is clean. */
  mergeTarget?: string;
  /** Where every agent's full output is written, shown in the footer. */
  logsDir?: string;
  /** `Date.now()` when the run started. */
  startedAt: number;
  /** Called on Ctrl+C: in raw mode the terminal sends no SIGINT by itself. */
  onInterrupt?: () => void;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m ${s}s` : `${m}m ${s}s`;
}

/** Ticks every `ms` so spinners spin and the elapsed time never looks frozen (PRD §11); stops once `active` is false. */
function useTick(ms: number, active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
  return tick;
}

const TITLE = "GRAPH·EXECUTION";

/** The title, in a gradient from the accent to the second accent. */
function Title() {
  return (
    <Text bold>
      <Text color={THEME.accent}>{"◢◤ "}</Text>
      {[...TITLE].map((ch, i) => (
        <Text key={i} color={mix(THEME.accent, THEME.accent2, i / (TITLE.length - 1))}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

const BAR_WIDTH = 20;

/** How many tasks are merged, as a segmented bar. */
function Progress({ nodes }: { nodes: ViewState["nodes"] }) {
  const all = Object.values(nodes);
  const merged = all.filter((n) => n.status === "merged").length;
  const filled = all.length === 0 ? 0 : Math.round((merged / all.length) * BAR_WIDTH);
  return (
    <Text>
      <Text color={THEME.ok}>{"▰".repeat(filled)}</Text>
      <Text color={THEME.faint}>{"▱".repeat(BAR_WIDTH - filled)}</Text>
      <Text color={THEME.muted}>{`  ${merged}/${all.length} tasks merged`}</Text>
    </Text>
  );
}

const Key = ({ k, label }: { k: string; label: string }) => (
  <Text>
    <Text color="#0b0f14" backgroundColor={THEME.muted}>{` ${k} `}</Text>
    <Text color={THEME.muted}>{` ${label}`}</Text>
  </Text>
);

/**
 * The live run view (PRD §7.9): header, phase pipeline, the run as one top-down graph (tasks, then validation,
 * reviewers, fixer and apply) and a footer with where the agent logs are; once the run is over, the final summary in
 * place of the footer.
 */
export function App({ store, layers, parents = {}, runId, provider, mergeTarget, logsDir, startedAt, onInterrupt }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { stdout } = useStdout();
  const frame = useTick(100, !state.summary);
  const [endedAt, setEndedAt] = useState<number>();
  useEffect(() => {
    if (state.summary && endedAt === undefined) setEndedAt(Date.now());
  }, [state.summary, endedAt]);
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt?.();
  });
  const columns = stdout.columns > 0 ? stdout.columns : 100;
  const graph = renderGraph({ layers, parents, state, mergeTarget, frame, columns });
  return (
    <Box flexDirection="column">
      <Box gap={3}>
        <Title />
        <Text color={THEME.muted}>
          run <Text color={THEME.text}>{runId}</Text>
        </Text>
        <Text color={THEME.muted}>
          provider <Text color={THEME.text}>{provider}</Text>
        </Text>
        <Text color={THEME.muted}>
          elapsed <Text color={THEME.text}>{formatElapsed((endedAt ?? Date.now()) - startedAt)}</Text>
        </Text>
      </Box>
      <Text color={THEME.faint}>{"─".repeat(Math.min(columns, 100))}</Text>
      <PhaseBar phase={state.phase} merge={state.merge.status} frame={frame} />
      <Progress nodes={state.nodes} />
      {graph.element}
      {state.summary ? (
        <Summary end={state.summary} />
      ) : (
        <Box gap={3}>
          <Key k="ctrl+c" label="abort (resumable)" />
          {logsDir ? <Text color={THEME.muted}>{`agent logs → ${logsDir}`}</Text> : null}
        </Box>
      )}
    </Box>
  );
}
