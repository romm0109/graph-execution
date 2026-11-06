import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, post } from "../api";
import TerminalView from "../components/TerminalView";

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  workspaceId?: string;
  status: "working" | "idle" | "exited";
  exitCode?: number;
  createdAt: string;
  lastOutputAt?: string;
}

const POLL_MS = 1500;

export function statusText(t: TerminalInfo): string {
  return t.status === "exited" ? `exited ${t.exitCode ?? ""}`.trim() : t.status;
}

/** The cwd shown in the sidebar: the workspace id when there is one. */
export function shortCwd(t: TerminalInfo): string {
  if (t.workspaceId) return t.workspaceId;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || t.cwd;
}

export default function Terminals() {
  const [params, setParams] = useSearchParams();
  const workspace = params.get("workspace") ?? undefined;
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>(params.get("terminal") ?? undefined);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ terminals: TerminalInfo[] }>("/api/terminals");
      setTerminals(res.terminals);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const create = useCallback(
    async (workspaceId?: string) => {
      try {
        const info = await post<TerminalInfo>("/api/terminals", workspaceId ? { workspaceId } : {});
        setTerminals((ts) => [...(ts ?? []).filter((t) => t.id !== info.id), info]);
        setActiveId(info.id);
        setError(null);
        return info;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [],
  );

  // `?workspace=<id>` (from the Workspaces page) opens a terminal there once; `&terminal=<tid>` marks it handled so a reload doesn't open another.
  useEffect(() => {
    if (!workspace || params.get("terminal") || handled.current === workspace) return;
    handled.current = workspace;
    void create(workspace).then((info) => {
      if (info) setParams({ workspace, terminal: info.id }, { replace: true });
    });
  }, [workspace, params, create, setParams]);

  /** Keeps `?terminal=` on the shown terminal, so a reload selects the same tab. */
  const markActive = useCallback(
    (id: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("terminal", id);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const select = (id: string) => {
    setActiveId(id);
    markActive(id);
  };

  const newTerminal = async () => {
    const info = await create(workspace);
    if (info) markActive(info.id);
  };

  const remove = async (t: TerminalInfo) => {
    if (t.status !== "exited" && !window.confirm(`Terminal "${t.title}" is still running. Close it?`)) return;
    try {
      await api(`/api/terminals/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setTerminals((ts) => (ts ?? []).filter((x) => x.id !== t.id));
    void refresh();
  };

  const list = terminals ?? [];
  const active = list.find((t) => t.id === activeId) ?? list[list.length - 1];

  return (
    <section data-testid="page-terminals" className="terminals">
      <aside className="terminal-sidebar">
        <button data-testid="new-terminal" onClick={() => void newTerminal()}>
          New terminal
        </button>
        {workspace && <div className="muted small">in {workspace}</div>}
        <ul className="terminal-list" data-testid="terminal-list">
          {list.map((t) => (
            <li key={t.id}>
              <button
                className={t.id === active?.id ? "terminal-item active" : "terminal-item"}
                data-testid={`terminal-item-${t.id}`}
                onClick={() => select(t.id)}
                title={t.cwd}
              >
                <span className="terminal-item-title">{t.title}</span>
                <span className="terminal-item-cwd muted">{shortCwd(t)}</span>
                <span className="terminal-status">
                  <span className={`status-dot ${t.status}`} />
                  {statusText(t)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {terminals !== null && list.length === 0 && <p className="muted small">No terminals yet.</p>}
        {error && <p className="error small">{error}</p>}
      </aside>
      <div className="terminal-main">
        <div className="terminal-tabs" role="tablist">
          {list.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === active?.id} className={t.id === active?.id ? "terminal-tab active" : "terminal-tab"}>
              <button className="tab-label" onClick={() => select(t.id)}>
                <span className={`status-dot ${t.status}`} />
                {t.title}
              </button>
              <button className="tab-close" aria-label={`Close ${t.title}`} onClick={() => void remove(t)}>
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-views">
          {list.map((t) => (
            <TerminalView key={t.id} id={t.id} active={t.id === active?.id} />
          ))}
          {terminals !== null && list.length === 0 && <div className="center muted">Open a terminal with New terminal.</div>}
        </div>
      </div>
    </section>
  );
}
