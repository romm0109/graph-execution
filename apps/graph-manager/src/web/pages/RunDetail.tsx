// Run detail (boards 10–13, 19): the run's own live page in an iframe while it runs, else the phase cards,
// the layered task graph, the task table and the Pull request panel.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, post } from "../api";
import { POLL_MS, type RunDetailResponse, type TaskRow, formatElapsed, relativeTime, taskProgress } from "../runs";
import type { TerminalInfo } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { RefLinks } from "../ui/RefLinks";
import { StatusBadge } from "../ui/StatusBadge";
import { useTheme } from "../ui/theme";
import { useToast } from "../ui/toast";
import { PhaseCards } from "./PhaseCards";
import { PrPanel } from "./PrPanel";
import { TaskGraph } from "./TaskGraph";
import "./RunDetail.css";

/** How often the live run page is probed, and how many failures in a row mean it is down. */
export const PROBE_MS = 5000;
const PROBE_FAILURES = 2;

/** `github~octo~hello` → `octo/hello`. */
/** Statuses without a Resume button: finished, or the plan stage (approval comes from the Approvals page). */
const NOT_RESUMABLE = new Set(["applied", "done", "planning", "needs-info", "awaiting-approval"]);

const fullPathOf = (ws: string): string => ws.split("~").slice(1).join("/") || ws;

async function probe(viewUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${viewUrl}state`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Rows of the task table; from the graph when the server sent none. */
function rowsOf(detail: RunDetailResponse): TaskRow[] {
  if (detail.tasks) return detail.tasks;
  const graph = detail.graph;
  if (!graph) return [];
  const deps = new Map<string, string[]>();
  for (const [from, to] of graph.edges) deps.set(to, [...(deps.get(to) ?? []), from]);
  return graph.nodes.map((n) => ({ id: n.id, title: n.title, status: n.status, attempts: detail.state?.tasks[n.id]?.attempts ?? 0, deps: deps.get(n.id) ?? [] }));
}

function elapsedOf(t: TaskRow, now: number): string {
  if (t.startedAt === undefined) return "—";
  if (t.endedAt !== undefined) return formatElapsed(t.endedAt - t.startedAt);
  return t.status === "running" || t.status === "validating" || t.status === "merging" ? formatElapsed(now - t.startedAt) : "—";
}

function TaskTable({ rows, highlighted }: { rows: TaskRow[]; highlighted?: string }) {
  const now = Date.now();
  return (
    <section className="task-table-card" aria-label="Tasks" data-testid="task-table">
      <div role="table" className="task-table">
        <div role="row" className="task-table-head">
          <span role="columnheader">Status</span>
          <span role="columnheader">Task</span>
          <span role="columnheader">Attempt</span>
          <span role="columnheader">Elapsed</span>
          <span role="columnheader">Lines</span>
          <span role="columnheader">Depends on</span>
        </div>
        {rows.map((t) => (
          <div
            role="row"
            key={t.id}
            id={`task-row-${t.id}`}
            data-testid={`task-row-${t.id}`}
            className={`task-table-row${highlighted === t.id ? " focused" : ""}`}
          >
            <span role="cell">
              <StatusBadge kind="task" value={t.status} />
            </span>
            <span role="cell" className="task-cell-name">
              <span className="task-cell-title" title={t.error ?? t.title}>
                {t.title}
              </span>
              <span className="mono task-cell-id">{t.id}</span>
            </span>
            <span role="cell" className="mono task-cell-num">
              {t.attempts > 0 ? t.attempts : "—"}
            </span>
            <span role="cell" className="mono task-cell-num" data-testid={`task-elapsed-${t.id}`}>
              {elapsedOf(t, now)}
            </span>
            <span role="cell" className="mono task-cell-lines" data-testid={`task-lines-${t.id}`}>
              {t.added !== undefined ? (
                <>
                  <span className="lines-add">+{t.added}</span> <span className="lines-del">−{t.deleted ?? 0}</span>
                </>
              ) : (
                "—"
              )}
            </span>
            <span role="cell" className="mono task-cell-deps" data-testid={`task-deps-${t.id}`}>
              {t.deps.length > 0 ? `← ${t.deps.join(", ")}` : "—"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveFrame({ viewUrl, theme, runId }: { viewUrl: string; theme: string; runId: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="run-live-wrap">
      <iframe className="run-live" src={`${viewUrl}?theme=${theme}`} title={`Run ${runId}`} data-testid="run-live-view" onLoad={() => setLoaded(true)} />
      {!loaded && (
        <div className="run-live-skeleton" aria-busy="true" data-testid="run-live-loading">
          <div className="run-live-skeleton-cards">
            <span />
            <span />
            <span />
          </div>
          <span className="muted">Connecting to the run page…</span>
        </div>
      )}
    </div>
  );
}

export default function RunDetail() {
  const { ws = "", runId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { resolved } = useTheme();
  const [detail, setDetail] = useState<RunDetailResponse | undefined>(undefined);
  const [error, setError] = useState("");
  /** The live page stopped answering (or the run stopped being live) while we showed it. */
  const [down, setDown] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const lastViewUrl = useRef<string | undefined>(undefined);
  const wasLive = useRef(false);

  const url = `/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}`;
  const load = useCallback(async () => {
    try {
      setDetail(await api<RunDetailResponse>(url));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 404 ? "This run does not exist (any more)." : err.error) : String(err));
    }
  }, [url]);

  useEffect(() => {
    setDetail(undefined);
    setDown(false);
    wasLive.current = false;
    lastViewUrl.current = undefined;
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const summary = detail?.summary;
  const live = summary?.live === true && summary.viewUrl !== undefined;
  const viewUrl = live ? summary.viewUrl : undefined;

  // The summary turning `live: false` after we showed the page: the page went down.
  useEffect(() => {
    if (!summary) return;
    if (live) {
      wasLive.current = true;
      lastViewUrl.current = viewUrl;
    } else if (wasLive.current) {
      setDown(true);
    }
  }, [summary, live, viewUrl]);

  // Probe the live page; two failures in a row switch to the static view.
  useEffect(() => {
    if (!viewUrl || down) return;
    let failures = 0;
    let cancelled = false;
    const t = setInterval(() => {
      if (document.hidden) return;
      void probe(viewUrl).then((ok) => {
        if (cancelled) return;
        failures = ok ? 0 : failures + 1;
        if (failures >= PROBE_FAILURES) setDown(true);
      });
    }, PROBE_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [viewUrl, down]);

  const retry = async (): Promise<void> => {
    const target = viewUrl ?? lastViewUrl.current;
    if (!target) return;
    setRetrying(true);
    const ok = await probe(target);
    setRetrying(false);
    if (ok) {
      setDown(false);
      void load();
    }
  };

  const openTerminal = async (): Promise<void> => {
    setOpening(true);
    try {
      const info = await post<TerminalInfo>("/api/terminals", { workspaceId: ws });
      void navigate(`/terminals?focus=${encodeURIComponent(info.id)}`);
    } catch (err) {
      toast.show({ tone: "bad", text: `Couldn't open a terminal: ${err instanceof ApiError ? err.error : String(err)}` });
    } finally {
      setOpening(false);
    }
  };

  const failText = (err: unknown): string => {
    if (!(err instanceof ApiError)) return String(err);
    const output = (err.body as { output?: unknown } | undefined)?.output;
    return typeof output === "string" && output !== "" && output !== err.error ? `${err.error}\n${output}` : err.error;
  };

  const resume = async (): Promise<void> => {
    setResuming(true);
    try {
      await post(`${url}/resume`);
      toast.show({ tone: "ok", text: `Resumed run ${runId}` });
      // Let the live frame come back once the summary turns live.
      setDown(false);
      wasLive.current = false;
      lastViewUrl.current = undefined;
      void load();
    } catch (err) {
      toast.show({ tone: "bad", text: `Couldn't resume: ${failText(err)}` });
    } finally {
      setResuming(false);
    }
  };

  const stopSandbox = async (): Promise<void> => {
    setStopping(true);
    try {
      await post(`${url}/sandbox/stop`);
      toast.show({ tone: "ok", text: `Stopped the sandbox of ${runId}` });
      setConfirmStop(false);
      void load();
    } catch (err) {
      toast.show({ tone: "bad", text: `Couldn't stop the sandbox: ${failText(err)}` });
    } finally {
      setStopping(false);
    }
  };

  const selectTask = (id: string): void => {
    setHighlighted(id);
    document.getElementById(`task-row-${id}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };

  const fullPath = fullPathOf(ws);
  // `#pr` (Create PR / `p` on the Runs page) asks for the Pull request form: show the static view even while the
  // finished run's page is still open; the ↗ button keeps the live page one click away.
  const wantsPr = location.hash === "#pr";
  const showLive = live && !down && viewUrl !== undefined && !wantsPr;
  const progress = taskProgress(summary?.taskCounts);
  const status = detail?.state?.status ?? summary?.status;
  const isSuite = summary?.type === "suite";
  /** The run finished and its page was closed on purpose (Close in the iframe): no "stopped responding" banner. */
  const ended = !live && status !== undefined && status !== "running" && status !== "review";
  // A run of the plan stage is not resumed from here: an awaiting-approval run is approved on the Approvals page.
  const canResume =
    summary !== undefined && !isSuite && !live && status !== undefined && !NOT_RESUMABLE.has(status) && !NOT_RESUMABLE.has(summary.status);
  const sandboxRunning = summary?.sandbox?.running === true;
  const stopButton = (testId: string) => (
    <button type="button" className="btn btn-sm" onClick={() => setConfirmStop(true)} disabled={stopping} data-testid={testId}>
      {stopping ? "Stopping…" : "Stop sandbox"}
    </button>
  );

  const header = (
    <header className="run-detail-head" data-testid="run-detail-head">
      <Link to="/runs" className="run-back">
        <Icon name="chevron-left" size={14} />
        Runs
      </Link>
      <span className="run-head-divider" aria-hidden="true" />
      <h1 className="run-id">{runId}</h1>
      {summary && <StatusBadge kind="run" value={summary.status} />}
      <span className="run-meta" data-testid="run-meta">
        <span className="mono">{fullPath}</span>
        {summary?.provider && (
          <>
            <span aria-hidden="true">·</span>
            <span className="mono">{summary.provider}</span>
          </>
        )}
        {summary?.refs && summary.refs.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <RefLinks refs={summary.refs} />
          </>
        )}
        {isSuite && (
          <>
            <span aria-hidden="true">·</span>
            <span>suite</span>
          </>
        )}
        {summary?.createdAt && (
          <>
            <span aria-hidden="true">·</span>
            <span>started {relativeTime(summary.createdAt)}</span>
          </>
        )}
        {progress && (
          <>
            <span aria-hidden="true">·</span>
            <span className="mono">{progress} merged</span>
          </>
        )}
        {summary && !live && (
          <>
            <span aria-hidden="true">·</span>
            <span>page not live</span>
          </>
        )}
        {summary?.sandbox && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className="run-sandbox-chip"
              data-testid="run-sandbox-chip"
              title={summary.sandbox.running ? "runs in a sandbox container" : summary.sandbox.gone ? "ran in a sandbox container; Resume starts a new one" : "its sandbox container is stopped"}
            >
              {summary.sandbox.image ? `sandbox · ${summary.sandbox.image}` : "sandbox"}
            </span>
          </>
        )}
      </span>
      <span className="run-head-actions">
        {canResume && (
          <button type="button" className="btn btn-sm" onClick={() => void resume()} disabled={resuming} data-testid="run-resume">
            {resuming ? "Resuming…" : "Resume"}
          </button>
        )}
        {sandboxRunning && stopButton("run-stop-sandbox")}
        <button type="button" className="btn btn-sm" onClick={() => void openTerminal()} disabled={opening || !ws} data-testid="open-terminal">
          <Icon name="terminal" size={14} />
          Open terminal here
        </button>
        {live && viewUrl && (
          <a className="btn btn-sm btn-icon" href={viewUrl} target="_blank" rel="noreferrer" aria-label="Open the run page in a new tab" title="open ↗" data-testid="open-live">
            <Icon name="external" size={14} />
          </a>
        )}
      </span>
      <ConfirmDialog
        open={confirmStop}
        tone="danger"
        title="Stop the sandbox?"
        body="Its container is stopped (SIGTERM, then SIGKILL after 10 s). The run stays as it is; Resume continues it in a new sandbox."
        confirmLabel="Stop sandbox"
        busy={stopping}
        onConfirm={() => void stopSandbox()}
        onCancel={() => setConfirmStop(false)}
      />
    </header>
  );

  const banner = down && !ended && (
    <div className="run-down-banner" role="status" data-testid="page-down-banner">
      <span>The run page stopped responding. Showing the static graph.</span>
      <button type="button" className="btn btn-sm" onClick={() => void retry()} disabled={retrying} data-testid="page-retry">
        {retrying ? "Retrying…" : "Retry"}
      </button>
      {summary?.sandbox && !summary.sandbox.gone && stopButton("page-stop-sandbox")}
    </div>
  );

  const questions = summary?.status === "needs-info" && summary.questions?.length ? (
    <section className="run-questions" data-testid="run-questions" aria-label="Needs more information">
      <h2>Needs more information</h2>
      {summary.questions.map((q, i) => (
        <div key={`${q.ref ?? ""}-${String(i)}`} className="run-questions-entry">
          <h3 className="mono">{q.ref ?? "Content"}</h3>
          <ul>
            {q.questions.map((text, j) => (
              <li key={j}>{text}</li>
            ))}
          </ul>
        </div>
      ))}
      {summary.dropped && summary.dropped.length > 0 && <p className="muted">Dropped: {summary.dropped.join(", ")}</p>}
    </section>
  ) : null;

  if (showLive) {
    return (
      <div data-testid="page-run-detail" className="page run-detail is-live">
        {header}
        <LiveFrame key={viewUrl} viewUrl={viewUrl} theme={resolved} runId={runId} />
      </div>
    );
  }

  const rows = detail ? rowsOf(detail) : [];
  const graph = detail?.graph;

  return (
    <div data-testid="page-run-detail" className="page run-detail">
      {header}
      {banner}
      {questions}
      {error && (
        <p className="run-detail-error" role="alert">
          {error}
        </p>
      )}
      {!detail && !error && (
        <div className="run-detail-body">
          <p className="muted">Loading…</p>
        </div>
      )}
      {detail && isSuite && (
        <div className="run-detail-body single" data-testid="run-static-graph">
          <EmptyState title={`Suite ${runId} — open its page while it runs to see the features.`} body={<>Status: {summary?.status}</>} />
        </div>
      )}
      {detail && !isSuite && (
        <div className="run-detail-body">
          <div className="run-detail-main" data-testid="run-static-graph">
            {detail.state && <PhaseCards detail={detail} fullPath={fullPath} />}
            <section className="task-graph-card" aria-label="Task graph">
              <div className="task-graph-head">
                <h2>Task graph</h2>
                {progress && <span className="mono muted">{progress} merged</span>}
                <span className="run-head-spacer" />
                <span className="muted task-graph-caption">columns = dependency layers</span>
              </div>
              {graph && graph.nodes.length > 0 ? (
                <TaskGraph graph={graph} tasks={rows} onSelect={selectTask} selected={highlighted} />
              ) : (
                <p className="muted task-graph-empty">No task graph for this run.</p>
              )}
            </section>
            {rows.length > 0 && <TaskTable rows={rows} highlighted={highlighted} />}
          </div>
          <aside className="run-detail-side">
            <PrPanel ws={ws} runId={runId} status={status} fullPath={fullPath} />
          </aside>
        </div>
      )}
    </div>
  );
}
