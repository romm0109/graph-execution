// Run detail (boards 10–13, 19): the run's own live page in an iframe while it runs, else the phase cards,
// the layered task graph, the task table and the Pull request panel.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, post } from "../api";
import { POLL_MS, type RunDetailResponse, type TaskRow, formatElapsed, isProjectId, projectOfHome, relativeTime, taskProgress } from "../runs";
import type { TerminalInfo } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
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
  /** An archived run never changes: the poll stops after the first load. */
  const archivedRef = useRef(false);

  const url = `/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}`;
  const load = useCallback(async () => {
    try {
      const d = await api<RunDetailResponse>(url);
      archivedRef.current = d.archived === true;
      setDetail(d);
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
    archivedRef.current = false;
    void load();
    const t = setInterval(() => {
      if (!document.hidden && !archivedRef.current) void load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden && !archivedRef.current) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const summary = detail?.summary;
  /** From the run archive: its workspace or session is gone, so the page is read-only. */
  const archived = detail?.archived === true;
  const live = !archived && summary?.live === true && summary.viewUrl !== undefined;
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
      const info = await post<TerminalInfo>("/api/terminals", isProjectId(ws) ? { projectId: projectOfHome(ws) } : { workspaceId: ws });
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
  const project = summary?.project;
  // A suite is resumed from a terminal, except a project's (its page can resume it in the project folder).
  const canResume = summary !== undefined && !archived && (!isSuite || project !== undefined) && !live && status !== undefined && status !== "applied" && status !== "done";
  const sandboxRunning = !archived && summary?.sandbox?.running === true;
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
        {project ? (
          <>
            <span className="run-project-chip" data-testid="run-project">
              project · {project.name}
            </span>
            <span className="mono">{project.repos.join(", ")}</span>
          </>
        ) : (
          <span className="mono">{fullPath}</span>
        )}
        {summary?.provider && (
          <>
            <span aria-hidden="true">·</span>
            <span className="mono">{summary.provider}</span>
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
        {!archived && (
          <button type="button" className="btn btn-sm" onClick={() => void openTerminal()} disabled={opening || !ws} data-testid="open-terminal">
            <Icon name="terminal" size={14} />
            Open terminal here
          </button>
        )}
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

  const archivedBanner = archived && (
    <div className="run-archived-banner" role="status" data-testid="run-archived-banner">
      This session has ended. The run page is no longer live.
    </div>
  );

  const banner = down && !ended && !archived && (
    <div className="run-down-banner" role="status" data-testid="page-down-banner">
      <span>The run page stopped responding. Showing the static graph.</span>
      <button type="button" className="btn btn-sm" onClick={() => void retry()} disabled={retrying} data-testid="page-retry">
        {retrying ? "Retrying…" : "Retry"}
      </button>
      {summary?.sandbox && !summary.sandbox.gone && stopButton("page-stop-sandbox")}
    </div>
  );

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
      {archivedBanner}
      {banner}
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
        <div className={`run-detail-body${project ? "" : " single"}`} data-testid="run-static-graph">
          <EmptyState
            title={`Suite ${runId} — open its page while it runs to see the features.`}
            body={
              project ? (
                <>
                  Status: {summary?.status}
                  <span className="run-project-repos" data-testid="run-project-repos">
                    {project.repos.map((r) => (
                      <span key={r} className="run-project-repo mono">
                        {r}
                      </span>
                    ))}
                  </span>
                </>
              ) : (
                <>Status: {summary?.status}</>
              )
            }
          />
          {project && !archived && (
            <aside className="run-detail-side">
              <PrPanel ws={ws} runId={runId} status={status} project />
            </aside>
          )}
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
            {archived && detail.logTail && (
              <section className="run-archive-card" aria-label="Run log">
                <h2>Run log</h2>
                <pre className="run-archive-pre mono" data-testid="run-log-tail">
                  {detail.logTail}
                </pre>
              </section>
            )}
            {archived && <ArchiveFiles url={url} files={detail.files ?? []} />}
          </div>
          {archived && summary?.pr && (
            <aside className="run-detail-side">
              <a className="run-archive-pr mono" href={summary.pr.url} target="_blank" rel="noreferrer" data-testid="run-archived-pr">
                {summary.pr.forge === "gitlab" ? `MR !${summary.pr.number} ↗` : `PR #${summary.pr.number} ↗`}
              </a>
            </aside>
          )}
          {!project && !archived && (
            <aside className="run-detail-side">
              <PrPanel ws={ws} runId={runId} status={status} fullPath={fullPath} />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

/** The archived files worth opening: logs, reports, summaries and run.log. */
const ARCHIVE_SHOWN = (f: string): boolean => f === "run.log" || f.startsWith("logs/") || f.startsWith("reports/") || f.startsWith("summaries/");

/** The files of an archived run folder; a click opens one in a panel below. */
function ArchiveFiles({ url, files }: { url: string; files: string[] }) {
  const shown = files.filter(ARCHIVE_SHOWN);
  const [open, setOpen] = useState<{ path: string; text?: string; error?: string } | undefined>(undefined);
  const view = async (p: string): Promise<void> => {
    setOpen({ path: p });
    try {
      const res = await fetch(`${url}/archive/file?path=${encodeURIComponent(p)}`, { credentials: "same-origin" });
      const text = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? msg;
        } catch {
          // not JSON
        }
        setOpen({ path: p, error: msg });
        return;
      }
      setOpen({ path: p, text });
    } catch (err) {
      setOpen({ path: p, error: String(err) });
    }
  };
  return (
    <section className="run-archive-card" aria-label="Files">
      <h2>Files</h2>
      {shown.length === 0 ? (
        <p className="muted">No logs or reports were archived.</p>
      ) : (
        <ul className="run-archive-files">
          {shown.map((f) => (
            <li key={f}>
              <button type="button" className={open?.path === f ? "run-archive-file mono active" : "run-archive-file mono"} onClick={() => void view(f)} data-testid={`archive-file-${f}`}>
                {f}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="run-archive-view">
          <h3 className="mono">{open.path}</h3>
          {open.error ? (
            <p className="run-detail-error" role="alert">
              {open.error}
            </p>
          ) : (
            <pre className="run-archive-pre mono" data-testid="archive-file-view">
              {open.text ?? "Loading…"}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
