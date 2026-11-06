import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api, post } from "../api";
import { POLL_MS, type RunSummary, relativeTime, taskProgress, workspaceLabel } from "../runs";

const PROVIDERS: { value: string; label: string }[] = [
  { value: "claude", label: "claude" },
  { value: "codex", label: "codex" },
  { value: "opencode", label: "opencode" },
  { value: "qwen", label: "qwen" },
  { value: "fake", label: "fake (testing)" },
];

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

function StartRunForm({ workspaces, initial, onClose }: { workspaces: string[]; initial: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [ws, setWs] = useState(initial || workspaces[0] || "");
  const [tasksDir, setTasksDir] = useState(".agents/tasks");
  const [spec, setSpec] = useState("");
  const [provider, setProvider] = useState("claude");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await post<{ runId: string }>(`/api/runs/${encodeURIComponent(ws)}`, { tasksDir, spec, provider });
      navigate(`/runs/${encodeURIComponent(ws)}/${encodeURIComponent(res.runId)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.error : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card start-run" onSubmit={(e) => void submit(e)} data-testid="start-run-form">
      <h2>Start a run</h2>
      <label>
        Workspace
        <select value={ws} onChange={(e) => setWs(e.target.value)} required data-testid="start-run-workspace">
          {workspaces.length === 0 && <option value="">No workspaces</option>}
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {workspaceLabel(w)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tasks folder
        <input value={tasksDir} onChange={(e) => setTasksDir(e.target.value)} required data-testid="start-run-tasks" />
      </label>
      <label>
        Spec
        <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="docs/prd/feature.md" required data-testid="start-run-spec" />
      </label>
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="start-run-provider">
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <pre className="error start-run-error" data-testid="start-run-error">
          {error}
        </pre>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !ws} data-testid="start-run-submit">
          {busy ? "Starting…" : "Start"}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function Runs() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = params.get("workspace") ?? "";
  const [runs, setRuns] = useState<RunSummary[] | undefined>(undefined);
  const [error, setError] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const res = await api<{ runs: RunSummary[] }>("/api/runs");
      setRuns(res.runs);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.error : String(err));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    // Workspaces without runs come from the workspaces API; the runs list fills in if it is unavailable.
    api<{ workspaces?: { id: string }[] }>("/api/workspaces")
      .then((res) => setKnown((res.workspaces ?? []).map((w) => w.id)))
      .catch(() => setKnown([]));
  }, []);

  const workspaces = useMemo(() => {
    const ids = new Set(known);
    for (const r of runs ?? []) ids.add(r.workspaceId);
    if (filter) ids.add(filter);
    return [...ids].sort();
  }, [known, runs, filter]);

  const shown = (runs ?? []).filter((r) => !filter || r.workspaceId === filter);
  const open = (r: RunSummary) => navigate(`/runs/${encodeURIComponent(r.workspaceId)}/${encodeURIComponent(r.id)}`);

  return (
    <section data-testid="page-runs">
      <div className="page-head">
        <h1>Runs</h1>
        <div className="spacer" />
        <select
          value={filter}
          onChange={(e) => setParams(e.target.value ? { workspace: e.target.value } : {})}
          aria-label="Workspace filter"
          data-testid="runs-filter"
        >
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {workspaceLabel(w)}
            </option>
          ))}
        </select>
        <button onClick={() => setStarting((s) => !s)} data-testid="start-run">
          Start run
        </button>
      </div>
      {starting && <StartRunForm workspaces={workspaces} initial={filter} onClose={() => setStarting(false)} />}
      {error && <p className="error">{error}</p>}
      {runs === undefined ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="table" data-testid="runs-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Run</th>
              <th>Type</th>
              <th>Status</th>
              <th>Live</th>
              <th>Provider</th>
              <th>Tasks</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr
                key={`${r.workspaceId}/${r.id}`}
                className="clickable"
                onClick={() => open(r)}
                onKeyDown={(e) => e.key === "Enter" && open(r)}
                tabIndex={0}
                data-testid={`run-row-${r.workspaceId}-${r.id}`}
              >
                <td>{workspaceLabel(r.workspaceId)}</td>
                <td>
                  <code>{r.id}</code>
                </td>
                <td>{r.type}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td>{r.live ? <span className="live-dot" title="Page server is up" aria-label="live" /> : null}</td>
                <td>{r.provider ?? ""}</td>
                <td>{taskProgress(r.taskCounts)}</td>
                <td title={r.createdAt}>{relativeTime(r.createdAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
