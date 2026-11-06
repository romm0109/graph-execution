import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, post } from "../api";

export interface WorkspaceEntry {
  id: string;
  forge: string;
  fullPath: string;
  path: string;
  branch: string;
  dirty: boolean;
  remoteUrl: string;
}

interface Repo {
  fullPath: string;
  name: string;
  private: boolean;
  webUrl: string;
}

type ForgeKind = "github" | "gitlab";
const FORGE_NAMES: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab" };
const FORGE_ICON: Record<string, string> = { github: "GH", gitlab: "GL" };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type CloneState = { status: "cloning" } | { status: "done" } | { status: "error"; error: string };

function ClonePanel({ onCloned }: { onCloned: () => void }) {
  const [connected, setConnected] = useState<ForgeKind[] | null>(null);
  const [kind, setKind] = useState<ForgeKind | "">("");
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clones, setClones] = useState<Record<string, CloneState>>({});

  useEffect(() => {
    api<Record<ForgeKind, { connected: boolean }>>("/api/forges")
      .then((f) => {
        const kinds = (["github", "gitlab"] as const).filter((k) => f[k]?.connected);
        setConnected(kinds);
        setKind(kinds[0] ?? "");
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);

  useEffect(() => {
    if (!kind) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      api<{ repos: Repo[] }>(`/api/forges/${kind}/repos?q=${encodeURIComponent(query)}`)
        .then((r) => {
          if (stale) return;
          setRepos(r.repos);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!stale) setError(message(err));
        });
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [kind, query]);

  const clone = async (fullPath: string) => {
    if (!kind) return;
    const key = `${kind}:${fullPath}`;
    setClones((c) => ({ ...c, [key]: { status: "cloning" } }));
    try {
      await post("/api/workspaces", { forge: kind, fullPath });
      setClones((c) => ({ ...c, [key]: { status: "done" } }));
      onCloned();
    } catch (err) {
      setClones((c) => ({ ...c, [key]: { status: "error", error: message(err) } }));
    }
  };

  if (connected === null) return <div className="card clone-panel">{error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}</div>;
  if (connected.length === 0) {
    return (
      <div className="card clone-panel" data-testid="clone-panel">
        <p className="muted">
          No forge is connected. Connect GitHub or GitLab in <Link to="/settings">Settings</Link>.
        </p>
      </div>
    );
  }
  return (
    <div className="card clone-panel" data-testid="clone-panel">
      <div className="clone-controls">
        <select aria-label="Forge" data-testid="forge-select" value={kind} onChange={(e) => { setKind(e.target.value as ForgeKind); setRepos(null); }}>
          {connected.map((k) => (
            <option key={k} value={k}>
              {FORGE_NAMES[k]}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Search repositories" aria-label="Search repositories" data-testid="repo-search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {repos === null ? (
        <p className="muted">Loading…</p>
      ) : repos.length === 0 ? (
        <p className="muted">No repositories found.</p>
      ) : (
        <ul className="repo-list">
          {repos.map((r) => {
            const st = clones[`${kind}:${r.fullPath}`];
            return (
              <li key={r.fullPath} className="repo-item" data-testid={`repo-${r.fullPath}`}>
                <span className="mono">{r.fullPath}</span>
                {r.private && <span className="badge">private</span>}
                <span className="spacer" />
                {st?.status === "error" && (
                  <span className="error small" role="alert">
                    {st.error}
                  </span>
                )}
                {st?.status === "done" && <span className="muted small">Cloned</span>}
                <button type="button" data-testid={`clone-${r.fullPath}`} disabled={st?.status === "cloning" || st?.status === "done"} onClick={() => void clone(r.fullPath)}>
                  {st?.status === "cloning" ? "Cloning…" : "Clone"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Workspaces() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ workspaces: WorkspaceEntry[] }>("/api/workspaces");
      setWorkspaces(res.workspaces);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (ws: WorkspaceEntry) => {
    if (!window.confirm(`Delete ${ws.forge}/${ws.fullPath}? This removes the folder and its terminals.`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(ws.id)}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <section data-testid="page-workspaces" className="workspaces">
      <div className="page-header">
        <h1>Workspaces</h1>
        <button type="button" data-testid="clone-open" onClick={() => setPanelOpen((o) => !o)}>
          {panelOpen ? "Close" : "Clone repository"}
        </button>
      </div>
      {panelOpen && <ClonePanel onCloned={() => void refresh()} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {workspaces === null ? (
        <p className="muted">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="muted">No workspaces yet. Clone a repository to start.</p>
      ) : (
        <ul className="workspace-list">
          {workspaces.map((ws) => (
            <li key={ws.id} className="card workspace-item" data-testid={`workspace-${ws.id}`}>
              <span className="badge" title={ws.forge}>
                {FORGE_ICON[ws.forge] ?? ws.forge}
              </span>
              <div className="workspace-info">
                <span className="mono workspace-name">{ws.fullPath}</span>
                <span className="muted small">
                  <span className="mono">{ws.branch || "?"}</span>
                  {ws.remoteUrl && <> · {ws.remoteUrl}</>}
                </span>
              </div>
              <span className={ws.dirty ? "badge dirty" : "badge clean"} data-testid={`state-${ws.id}`}>
                {ws.dirty ? "dirty" : "clean"}
              </span>
              <span className="spacer" />
              <button type="button" data-testid={`open-terminal-${ws.id}`} onClick={() => navigate(`/terminals?workspace=${encodeURIComponent(ws.id)}`)}>
                Open terminal
              </button>
              <button type="button" className="secondary" data-testid={`runs-${ws.id}`} onClick={() => navigate(`/runs?workspace=${encodeURIComponent(ws.id)}`)}>
                Runs
              </button>
              <button type="button" className="secondary" data-testid={`delete-${ws.id}`} onClick={() => void remove(ws)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
