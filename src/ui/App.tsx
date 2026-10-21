import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Static, Text, useInput, useStdout } from "ink";
import { Canvas, graphRows } from "./Graph.js";
import { graphModel } from "./model.js";
import { PhaseBar } from "./PhaseBar.js";
import { Summary } from "./Summary.js";
import type { RunEvent, RunStore, ViewState } from "./store.js";
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
  /** Where the human review happens (the in-process web view); shown while the run waits for it. */
  reviewUrl?: string;
  /** `Date.now()` when the run started. */
  startedAt: number;
  /** Called on Ctrl+C: in raw mode the terminal sends no SIGINT by itself. */
  onInterrupt?: () => void;
  /** Called on `r` with the selected failed node while the run waits for a retry. */
  onRetry?: (nodeId: string) => void;
  /** Called on `m` while the run waits and offers to merge what was done so far into `mergeTarget`. */
  onMerge?: () => void;
  /** Called on `q` while the run waits for a retry: the run ends and the final summary prints. */
  onQuit?: () => void;
  /** Turns on mouse reporting while the graph is scrollable, for the wheel; off in tests. */
  mouse?: boolean;
  /** The terminal height, when stdout does not tell (tests). */
  rows?: number;
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

/** Run events shown under the graph. */
export const EVENT_LINES = 3;

/**
 * Lines the live view needs besides the graph: header, rule, phase bar, progress, two blank lines, the events panel
 * (title and its lines) and the footer.
 */
const CHROME_LINES = 7 + 1 + EVENT_LINES;
/** Lines of the failure panel: title, two error lines, the cause and the verdict. */
const FAILURE_LINES = 5;
/** Lines one mouse wheel notch scrolls. */
const WHEEL_LINES = 3;

/** Mouse wheel reports in SGR mode (`ESC [ < 64 ; x ; y M` up, `65` down), as Ink passes them without the ESC. */
const WHEEL = /\[<(64|65);\d+;\d+[Mm]/g;

/** Turns SGR mouse reporting on, so wheel notches reach the app instead of scrolling the terminal. */
export const MOUSE_ON = "\u001B[?1000h\u001B[?1006h";
export const MOUSE_OFF = "\u001B[?1000l\u001B[?1006l";

/**
 * The live run view (PRD §7.9): header, phase pipeline, the run as one top-down graph (tasks, then validation,
 * reviewers, fixer and apply) and a footer with where the agent logs are.
 *
 * A graph taller than the terminal shows in a viewport, scrolled with the mouse wheel, ↑/↓, PgUp/PgDn or g/G. It
 * follows the first working node until the user scrolls, and `f` follows again. Once the run is over, the whole
 * graph and the final summary are written out once, in full, so the terminal's own scrollback holds all of it.
 */
export function App({
  store,
  layers,
  parents = {},
  runId,
  provider,
  mergeTarget,
  logsDir,
  reviewUrl,
  startedAt,
  onInterrupt,
  onRetry,
  onMerge,
  onQuit,
  mouse = false,
  rows,
}: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { stdout } = useStdout();
  const waiting = state.retryable.length > 0;
  const reviewing = Boolean(state.review?.waiting && reviewUrl);
  const frame = useTick(100, !state.summary || waiting);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = waiting ? state.retryable[Math.min(selectedIndex, state.retryable.length - 1)] : undefined;
  const [scroll, setScroll] = useState<{ offset: number; follow: boolean }>({ offset: 0, follow: true });

  const columns = stdout.columns > 0 ? stdout.columns : 100;
  const graph = graphRows({ layers, parents, state, mergeTarget, frame, columns, selected });
  // Ink redraws the whole screen once a frame is as tall as the terminal: the live frame stays one line shorter.
  // Without a known height (not a terminal) nothing limits the frame.
  const height = rows ?? (stdout.rows > 0 ? stdout.rows : 200);
  const room = Math.max(5, height - CHROME_LINES - (reviewing ? 1 : 0) - (waiting ? FAILURE_LINES + 1 : 0) - 1);
  const scrollable = graph.rows.length > room;
  const viewHeight = scrollable ? room - 1 : graph.rows.length;
  const maxOffset = Math.max(0, graph.rows.length - viewHeight);
  const clamp = (n: number): number => Math.min(maxOffset, Math.max(0, n));
  const followed = selected !== undefined ? (graph.nodeRows[selected] ?? graph.active[0]) : graph.active[0];
  const offset = clamp(scroll.follow && followed !== undefined ? followed - Math.floor(viewHeight / 3) : scroll.offset);
  // Input can arrive before Ink re-registers the handler after a render: it reads the latest view from here.
  const view = useRef({ offset, viewHeight, total: graph.rows.length, maxOffset, scrollable });
  view.current = { offset, viewHeight, total: graph.rows.length, maxOffset, scrollable };
  const choice = useRef({ retryable: state.retryable, mergeable: state.mergeable, index: 0 });
  choice.current = { retryable: state.retryable, mergeable: state.mergeable, index: Math.min(selectedIndex, Math.max(0, state.retryable.length - 1)) };

  const live = !state.summary || waiting;
  useEffect(() => {
    if (!mouse || !scrollable || !live) return;
    stdout.write(MOUSE_ON);
    return () => void stdout.write(MOUSE_OFF);
  }, [mouse, scrollable, live, stdout]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return onInterrupt?.();
    const { retryable, index } = choice.current;
    if (retryable.length > 0) {
      if (input === "r") return onRetry?.(retryable[index]!);
      if (input === "m" && choice.current.mergeable) return onMerge?.();
      if (input === "q") return onQuit?.();
      const step = key.tab && key.shift ? -1 : key.tab || key.downArrow || input === "j" ? 1 : key.upArrow || input === "k" ? -1 : 0;
      if (step !== 0) {
        const next = (index + step + retryable.length) % retryable.length;
        choice.current = { ...choice.current, index: next };
        setSelectedIndex(next);
        setScroll((s) => ({ ...s, follow: true }));
        return;
      }
    }
    const v = view.current;
    if (!v.scrollable) return;
    let delta = 0;
    for (const [, button] of input.matchAll(WHEEL)) delta += button === "64" ? -WHEEL_LINES : WHEEL_LINES;
    if (key.upArrow || input === "k") delta = -1;
    else if (key.downArrow || input === "j") delta = 1;
    else if (key.pageUp) delta = -(v.viewHeight - 1);
    else if (key.pageDown || input === " ") delta = v.viewHeight - 1;
    else if (input === "g") delta = -v.total;
    else if (input === "G") delta = v.total;
    else if (input === "f") {
      setScroll({ offset: v.offset, follow: true });
      return;
    }
    if (delta === 0) return;
    const next = Math.min(v.maxOffset, Math.max(0, v.offset + delta));
    view.current = { ...v, offset: next };
    setScroll({ offset: next, follow: false });
  });

  const header = (
    <>
      <Box gap={3}>
        <Title />
        <Text color={THEME.muted}>
          run <Text color={THEME.text}>{runId}</Text>
        </Text>
        <Text color={THEME.muted}>
          provider <Text color={THEME.text}>{provider}</Text>
        </Text>
        <Text color={THEME.muted}>
          elapsed <Text color={THEME.text}>{formatElapsed(Date.now() - startedAt)}</Text>
        </Text>
      </Box>
      <Text color={THEME.faint}>{"─".repeat(Math.min(columns, 100))}</Text>
      <PhaseBar phase={state.phase} merge={state.merge.status} frame={frame} />
      <Progress nodes={state.nodes} />
    </>
  );

  if (state.summary && !waiting) {
    // Written once, above the (now empty) live area: it stays in the terminal however tall it is.
    const end = state.summary;
    return (
      <Static items={[end]}>
        {(item) => (
          <Box key="final" flexDirection="column">
            {header}
            <Box marginY={1}>
              <Canvas rows={graph.rows} />
            </Box>
            <Summary end={item} />
          </Box>
        )}
      </Static>
    );
  }

  const titles = graphModel({ layers, parents, state, mergeTarget }).nodes;
  const above = offset;
  const below = graph.rows.length - offset - viewHeight;
  return (
    <Box flexDirection="column">
      {header}
      <Box marginY={1} flexDirection="column">
        <Canvas rows={graph.rows.slice(offset, offset + viewHeight)} />
        {scrollable ? (
          <Text color={THEME.muted}>
            {`${above > 0 ? `▲ ${above} above` : "▲ top"} · ${below > 0 ? `▼ ${below} below` : "▼ end"}  `}
            <Text color={THEME.faint}>
              {`wheel ↑↓ PgUp/PgDn g/G to scroll${scroll.follow ? " · following the running tasks" : " · f to follow the running tasks"}`}
            </Text>
          </Text>
        ) : null}
      </Box>
      <Events events={state.events} columns={columns} />
      {selected !== undefined ? <FailurePanel title={titles.get(selected)?.title ?? selected} failure={state.failures[selected]} /> : null}
      {reviewing ? <Text color="yellow">waiting for your review in the web view: {reviewUrl}</Text> : null}
      <Box gap={3}>
        {selected !== undefined ? (
          <>
            <Key k="r" label={`retry ${titles.get(selected)?.title ?? selected}`} />
            {state.mergeable ? <Key k="m" label={`merge into ${mergeTarget ?? "my branch"} as it is`} /> : null}
            <Key k="q" label="quit" />
          </>
        ) : (
          <Key k="ctrl+c" label="abort (resumable)" />
        )}
        {logsDir ? <Text color={THEME.muted}>{`agent logs → ${logsDir}`}</Text> : null}
      </Box>
    </Box>
  );
}

/** The latest run events, newest last, so it is clear what the run is doing (validation failures, fix rounds, merges). */
function Events({ events, columns }: { events: readonly RunEvent[]; columns: number }) {
  const shown = events.slice(-EVENT_LINES);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={THEME.accent}>▍</Text>
        <Text color={THEME.muted}>events</Text>
      </Text>
      {Array.from({ length: EVENT_LINES }, (_, i) => {
        const event = shown[i - (EVENT_LINES - shown.length)];
        if (!event) return <Text key={i}> </Text>;
        const latest = event === shown.at(-1);
        return (
          <Text key={i} wrap="truncate-end">
            <Text color={THEME.faint}>{`${event.time}  `}</Text>
            <Text color={latest ? THEME.text : THEME.muted}>{event.text.slice(0, Math.max(10, columns - 10))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

const VERDICT = {
  likely_to_work: { text: "Retry: likely to work", color: THEME.ok },
  unlikely_to_help: { text: "Retry: unlikely to help", color: THEME.bad },
  unclear: { text: "Retry: unclear", color: THEME.warn },
} as const;

/** The selected failed node: its error and, in plain words, the AI summary and whether a retry is worth it. */
function FailurePanel({ title, failure }: { title: string; failure: ViewState["failures"][string] | undefined }) {
  const error = (failure?.error ?? "").split("\n").filter((l) => l.trim() !== "").slice(0, 2);
  const summary = failure?.summary;
  const verdict = summary?.status === "ready" ? VERDICT[summary.verdict] : undefined;
  return (
    <Box flexDirection="column" height={FAILURE_LINES}>
      <Text bold color={THEME.bad}>{`✖ ${title} failed`}</Text>
      {[0, 1].map((i) => (
        <Text key={i} color={THEME.muted} wrap="truncate-end">
          {error[i] ?? " "}
        </Text>
      ))}
      {!failure ? (
        <Text> </Text>
      ) : summary?.status === "pending" ? (
        <Text color={THEME.muted}>summarizing…</Text>
      ) : summary?.status === "ready" ? (
        <Text wrap="truncate-end">{summary.cause}</Text>
      ) : (
        <Text color={THEME.muted}>No summary available</Text>
      )}
      {verdict && summary?.status === "ready" ? (
        <Text wrap="truncate-end">
          <Text color={verdict.color}>{verdict.text}</Text>
          <Text color={THEME.muted}>{` — ${summary.why}`}</Text>
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
