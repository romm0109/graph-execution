import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { Graph, ReviewNodes } from "./Graph.js";
import { LogTail } from "./LogTail.js";
import { PhaseBar } from "./PhaseBar.js";
import { Summary } from "./Summary.js";
import type { RunStore } from "./store.js";

export interface AppProps {
  store: RunStore;
  layers: string[][];
  runId: string;
  provider: string;
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

/** Ticks once a second so the elapsed time never looks frozen (PRD §11). */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The live run view (PRD §7.9): header, phase bar, task DAG with the review agents under it, the focused agent's log
 * tail and key hints; once the run is over, the final summary instead of the tail.
 */
export function App({ store, layers, runId, provider, startedAt, onInterrupt }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const now = useNow();
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt?.();
    else if (key.leftArrow || key.upArrow) store.moveFocus(-1);
    else if (key.rightArrow || key.downArrow) store.moveFocus(1);
  });
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold>graph-execution</Text>
        <Text>run {runId}</Text>
        <Text>provider {provider}</Text>
        <Text dimColor>elapsed {formatElapsed(now - startedAt)}</Text>
      </Box>
      <PhaseBar phase={state.phase} />
      <Graph layers={layers} nodes={state.nodes} focus={state.focus} />
      <ReviewNodes agents={state.agents} focus={state.focus} />
      {state.summary ? (
        <Summary end={state.summary} />
      ) : (
        <>
          <LogTail label={state.focus} tail={state.focus === undefined ? [] : (state.tails[state.focus] ?? [])} />
          <Text dimColor>←/→ switch agent · Ctrl+C abort (resumable)</Text>
        </>
      )}
    </Box>
  );
}
