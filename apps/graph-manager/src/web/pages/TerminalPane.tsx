// One pane of the Terminals split (boards 07–09, 19): a terminal (xterm, exit bar, reconnecting bar) or a run
// (its live page in an iframe while live, else the compact task graph).

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api";
import { Mascot } from "../components/Mascot";
import TerminalView, { type ConnectionState, type TerminalHandle } from "../components/TerminalView";
import { POLL_MS, type RunDetailResponse } from "../runs";
import type { AgentId, RunSummary, TerminalInfo } from "../types";
import { Icon } from "../ui/Icon";
import { StatusBadge } from "../ui/StatusBadge";
import { COARSE } from "../ui/media";
import { useTheme } from "../ui/theme";
import { last4 } from "./TerminalSidebar";
import { TaskGraph } from "./TaskGraph";

interface PaneChrome {
  /** 0-based pane index. */
  pane: number;
  focused: boolean;
  maximized: boolean;
  onFocus(): void;
  onMaximize(): void;
  onClose(): void;
}

function PaneHead({ chrome, title, path, badge, extra }: { chrome: PaneChrome; title: string; path: string; badge: ReactNode; extra?: ReactNode }) {
  return (
    <div className="tp-head">
      <span className="tp-num num">{chrome.pane + 1}</span>
      <strong className="tp-title">{title}</strong>
      <span className="tp-path mono" title={path}>
        {path}
      </span>
      {badge}
      <span className="tp-spacer" />
      {extra}
      <button type="button" className="tp-icon tp-max" aria-label={chrome.maximized ? "Restore panes" : "Maximize pane"} aria-pressed={chrome.maximized} onClick={chrome.onMaximize}>
        <Icon name="maximize" size={13} />
      </button>
      <button type="button" className="tp-icon" aria-label="Close pane" onClick={chrome.onClose} data-testid={`pane-close-${chrome.pane + 1}`}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

const AGENT_LABELS: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", qwen: "Qwen Code" };
/** Output this recent counts as the process working (the mascot bobs). */
const BUSY_MS = 1200;
/** Output this soon after a key is its echo, not the process working. */
const ECHO_MS = 400;
/** Instant echo on or off for every pane, remembered in this browser (on unless set to "off"; off by default on
 * touch screens). */
export const ECHO_KEY = "gm.instantEcho";

/** Saved "on"/"off" wins; with no saved choice, instant echo is on except on touch screens (phone keyboards send
 * composition and autocorrect input the predictor was not built for). */
export function defaultEcho(saved: string | null, coarse: boolean): boolean {
  if (saved === "on") return true;
  if (saved === "off") return false;
  return !coarse;
}

function readEcho(): boolean {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(ECHO_KEY);
  } catch {
    // Private mode: nothing saved.
  }
  return defaultEcho(saved, typeof window.matchMedia === "function" && window.matchMedia(COARSE).matches);
}

function saveEcho(on: boolean): void {
  try {
    window.localStorage.setItem(ECHO_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts until reload.
  }
}

/** Samples the latency readout keeps; it shows their median. */
export const LATENCY_SAMPLES = 5;

/**
 * The readout's value: the median of the last samples. One sample can be slow because the browser or the server was
 * busy at that moment (a redraw, a burst of output, garbage collection), which is not the network; the median keeps
 * those spikes out while a lasting change shows within a few samples.
 */
export function medianLatency(samples: number[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The latency readout's tone: fine under 80 ms, noticeable under 200 ms, slow above. */
export function latencyTone(ms: number): "ok" | "warn" | "bad" {
  return ms < 80 ? "ok" : ms < 200 ? "warn" : "bad";
}

export function TerminalPane({
  chrome,
  term,
  path,
  liveRun,
  spec,
  keyFilter,
  onOpenRun,
  onOpenSpec,
  onExited,
  onRestarted,
  handleRef,
  ctrlArmed,
  onCtrlUsed,
  onPrefixData,
}: {
  chrome: PaneChrome;
  term: TerminalInfo;
  path: string;
  liveRun?: RunSummary;
  /** The newest spec of the terminal's workspace, when it is watched: a chip reopens the floating spec pane. */
  spec?: { name: string; path: string };
  keyFilter: (e: KeyboardEvent) => boolean;
  onOpenRun(run: RunSummary): void;
  onOpenSpec?(path: string): void;
  onExited?(id: string, code: number): void;
  onRestarted?(id: string): void;
  /** The focused pane's terminal handle, for the extra-keys row. */
  handleRef?: MutableRefObject<TerminalHandle | null>;
  /** Sticky Ctrl (the extra-keys row) is on. */
  ctrlArmed?: () => boolean;
  onCtrlUsed?: () => void;
  /** A phone keyboard's key after the Ctrl Space prefix. */
  onPrefixData?: (data: string) => boolean;
}) {
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");
  const [echo, setEcho] = useState(readEcho);
  const [samples, setSamples] = useState<number[]>([]);
  const latency = medianLatency(samples);
  const onLatency = useCallback((ms: number) => setSamples((s) => [...s.slice(-(LATENCY_SAMPLES - 1)), ms]), []);
  const [busy, setBusy] = useState(false);
  const [fed, setFed] = useState(0);
  const busyTimer = useRef<number | undefined>(undefined);
  const busyRef = useRef(false);
  const lastKeyAt = useRef(0);
  const id = term.id;
  const label = term.agent ? AGENT_LABELS[term.agent] : term.process || "terminal";

  const onOutput = useCallback(() => {
    if (performance.now() - lastKeyAt.current < ECHO_MS) return;
    if (!busyRef.current) {
      busyRef.current = true;
      setBusy(true);
    }
    window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => {
      busyRef.current = false;
      setBusy(false);
    }, BUSY_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(busyTimer.current), []);
  const onInput = useCallback(() => (lastKeyAt.current = performance.now()), []);
  const onSubmit = useCallback(() => setFed((n) => n + 1), []);

  const toggleEcho = () => {
    const on = !echo;
    setEcho(on);
    saveEcho(on);
  };

  useEffect(() => {
    setExitCode(undefined);
    setConn("connecting");
    setSamples([]);
    setError("");
  }, [id]);

  const handleExit = useCallback(
    (code: number) => {
      setExitCode(code);
      onExited?.(id, code);
    },
    [id, onExited],
  );
  const handleRestart = useCallback(() => {
    setExitCode(undefined);
    onRestarted?.(id);
  }, [id, onRestarted]);

  const restart = async () => {
    setRestarting(true);
    setError("");
    try {
      await post(`/api/terminals/${encodeURIComponent(id)}/restart`);
      // The attached socket gets {type:"restart"} and the new output; clear the bar now in case it lags.
      handleRestart();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  };

  const exited = exitCode !== undefined;

  return (
    <section
      className={`tpane${chrome.focused ? " focused" : ""}`}
      aria-label={term.title}
      data-testid={`pane-${chrome.pane + 1}`}
      data-item={`t:${id}`}
      onMouseDown={chrome.onFocus}
      onFocusCapture={chrome.onFocus}
    >
      <PaneHead
        chrome={chrome}
        title={term.title}
        path={path}
        badge={null}
        extra={
          <>
            {spec && (
              <button type="button" className="run-chip run-chip-head spec-chip" title={spec.path} onClick={() => onOpenSpec?.(spec.path)} data-testid="pane-spec-chip">
                spec {spec.name}
              </button>
            )}
            {liveRun && (
              <button type="button" className="run-chip run-chip-head" onClick={() => onOpenRun(liveRun)} data-testid={`pane-run-chip-${liveRun.id}`}>
                run {last4(liveRun.id)} ↗
              </button>
            )}
          </>
        }
      />
      <div className="tp-body">
        <TerminalView
          id={id}
          active={chrome.focused}
          onExit={handleExit}
          onRestart={handleRestart}
          onConnection={setConn}
          keyFilter={keyFilter}
          onOutput={onOutput}
          onInput={onInput}
          onSubmit={onSubmit}
          onLatency={onLatency}
          instantEcho={echo}
          onTap={chrome.onFocus}
          handleRef={handleRef}
          ctrlArmed={ctrlArmed}
          onCtrlUsed={onCtrlUsed}
          onPrefixData={onPrefixData}
        />
      </div>
      {!exited && (
        <div className="tp-foot" data-testid="pane-foot">
          <span className={`tp-foot-dot${busy ? " busy" : ""}`} aria-hidden="true" />
          <span className="tp-foot-label">
            {label}
            <span className="tp-foot-state"> · {conn === "open" ? (busy ? "working" : "idle") : conn}</span>
          </span>
          {latency !== undefined && conn === "open" && (
            <span
              className={`tp-foot-ping mono tone-${latencyTone(latency)}`}
              title={`Round trip to the server: median of the last ${samples.length}. Latest ${Math.round(samples[samples.length - 1] ?? 0)} ms, best ${Math.round(Math.min(...samples))} ms, worst ${Math.round(Math.max(...samples))} ms. It includes moments the browser or server was busy.`}
              data-testid="pane-latency"
            >
              {Math.round(latency)} ms
            </span>
          )}
          <button
            type="button"
            className="tp-foot-chip"
            aria-pressed={echo}
            onClick={toggleEcho}
            title={echo ? "Typed characters show at once, before the server echoes them. Click to turn off." : "Typed characters show when the server echoes them. Click for instant echo."}
            data-testid="echo-toggle"
          >
            <Icon name="keyboard" size={12} />
            instant echo {echo ? "on" : "off"}
          </button>
          <span className="tp-spacer" />
          <Mascot agent={term.agent} label={label} busy={busy} fed={fed} />
        </div>
      )}
      {exited && (
        <div className="tp-bar tp-exit" role="status" data-testid="exit-bar">
          <span className="glyph glyph-diamond" aria-hidden="true" />
          <span className="tp-bar-text">Process exited with code {exitCode}</span>
          {error && <span className="tp-bar-error">{error}</span>}
          <button type="button" className="btn btn-sm tp-bar-btn" onClick={() => void restart()} disabled={restarting} data-testid="restart-terminal">
            Restart
          </button>
          <button type="button" className="btn btn-sm btn-ghost tp-bar-ghost" onClick={chrome.onClose}>
            Close
          </button>
        </div>
      )}
      {(conn === "reconnecting" || conn === "gone") && (
        <div className="tp-bar tp-reconnect" role="status" data-testid="reconnect-bar">
          {conn === "gone" ? "terminal not found" : "Reconnecting to the container… your scrollback is kept on the server."}
        </div>
      )}
    </section>
  );
}

export function RunPane({ chrome, ws, runId, path, summary }: { chrome: PaneChrome; ws: string; runId: string; path: string; summary?: RunSummary }) {
  const { resolved } = useTheme();
  const [detail, setDetail] = useState<RunDetailResponse | undefined>(undefined);
  const [error, setError] = useState("");
  const url = `/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}`;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await api<RunDetailResponse>(url);
        if (alive) {
          setDetail(d);
          setError("");
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    setDetail(undefined);
    void load();
    const t = window.setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [url]);

  const s = detail?.summary ?? summary;
  const viewUrl = s?.live && s.viewUrl ? s.viewUrl : undefined;
  const graph = detail?.graph;
  return (
    <section
      className={`tpane run${chrome.focused ? " focused" : ""}`}
      aria-label={`run ${last4(runId)}`}
      data-testid={`pane-${chrome.pane + 1}`}
      data-item={`r:${ws}/${runId}`}
      onMouseDown={chrome.onFocus}
      onFocusCapture={chrome.onFocus}
    >
      <PaneHead
        chrome={chrome}
        title={`run ${last4(runId)}`}
        path={path}
        badge={s ? <StatusBadge kind="run" value={s.status} /> : null}
        extra={
          <Link className="run-chip run-chip-head" to={`/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}`}>
            open ↗
          </Link>
        }
      />
      <div className="tp-run-body">
        {viewUrl ? (
          <iframe className="tp-run-frame" src={`${viewUrl}?theme=${resolved}`} title={`Run ${runId}`} data-testid="pane-run-live" />
        ) : graph && graph.nodes.length > 0 ? (
          <div className="tp-run-graph" data-testid="pane-run-graph">
            <TaskGraph graph={graph} tasks={detail?.tasks} compact />
          </div>
        ) : (
          <p className="muted tp-run-empty">{error || (detail ? "No task graph for this run." : "Loading…")}</p>
        )}
      </div>
    </section>
  );
}

/** An empty slot of the split. */
export function EmptyPane({ chrome }: { chrome: PaneChrome }) {
  return (
    <section className={`tpane empty${chrome.focused ? " focused" : ""}`} data-testid={`pane-${chrome.pane + 1}`} onMouseDown={chrome.onFocus}>
      <div className="tp-empty">
        <span className="tp-num num">{chrome.pane + 1}</span>
        <span>Empty pane. Pick a tab or a terminal to show it here.</span>
      </div>
    </section>
  );
}

export type { PaneChrome };
