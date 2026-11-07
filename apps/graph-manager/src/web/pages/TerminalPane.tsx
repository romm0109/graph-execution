// One pane of the Terminals split (boards 07–09, 19): a terminal (xterm, exit bar, reconnecting bar) or a run
// (its live page in an iframe while live, else the compact task graph).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api";
import TerminalView, { type ConnectionState } from "../components/TerminalView";
import { POLL_MS, type RunDetailResponse } from "../runs";
import type { RunSummary, TerminalInfo } from "../types";
import { Icon } from "../ui/Icon";
import { StatusBadge } from "../ui/StatusBadge";
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
      <button type="button" className="tp-icon" aria-label={chrome.maximized ? "Restore panes" : "Maximize pane"} aria-pressed={chrome.maximized} onClick={chrome.onMaximize}>
        <Icon name="maximize" size={13} />
      </button>
      <button type="button" className="tp-icon" aria-label="Close pane" onClick={chrome.onClose} data-testid={`pane-close-${chrome.pane + 1}`}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

export function TerminalPane({
  chrome,
  term,
  path,
  liveRun,
  keyFilter,
  onOpenRun,
  onExited,
  onRestarted,
}: {
  chrome: PaneChrome;
  term: TerminalInfo;
  path: string;
  liveRun?: RunSummary;
  keyFilter: (e: KeyboardEvent) => boolean;
  onOpenRun(run: RunSummary): void;
  onExited?(id: string, code: number): void;
  onRestarted?(id: string): void;
}) {
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");
  const id = term.id;

  useEffect(() => {
    setExitCode(undefined);
    setConn("connecting");
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
          liveRun && (
            <button type="button" className="run-chip run-chip-head" onClick={() => onOpenRun(liveRun)} data-testid={`pane-run-chip-${liveRun.id}`}>
              run {last4(liveRun.id)} ↗
            </button>
          )
        }
      />
      <div className="tp-body">
        <TerminalView id={id} active={chrome.focused} onExit={handleExit} onRestart={handleRestart} onConnection={setConn} keyFilter={keyFilter} />
      </div>
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
