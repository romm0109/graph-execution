import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api, post } from "../api";
import { POLL_MS, type RunDetailResponse, type RunGraph, relativeTime, workspaceLabel } from "../runs";
import { StatusBadge } from "./Runs";

const NODE_W = 200;
const NODE_H = 54;
const COL_GAP = 70;
const ROW_GAP = 18;
const PAD = 12;

/** One column per layer, a box per task and a line per dependency. */
export function StaticGraph({ graph }: { graph: RunGraph }) {
  const pos = new Map<string, { x: number; y: number }>();
  graph.layers.forEach((layer, col) =>
    layer.forEach((id, row) => pos.set(id, { x: PAD + col * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP) })),
  );
  const rows = Math.max(1, ...graph.layers.map((l) => l.length));
  const width = PAD * 2 + Math.max(1, graph.layers.length) * (NODE_W + COL_GAP) - COL_GAP;
  const height = PAD * 2 + rows * (NODE_H + ROW_GAP) - ROW_GAP;
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return (
    <div className="graph-scroll">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Task graph">
        {graph.edges.map(([from, to]) => {
          const a = pos.get(from);
          const b = pos.get(to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return <path key={`${from}->${to}`} className="graph-edge" d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} />;
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`graph-node status-${n.status}`} data-testid={`graph-node-${n.id}`}>
              <title>{`${n.title} (${n.id}): ${n.status}`}</title>
              <rect width={NODE_W} height={NODE_H} rx={8} />
              <text x={10} y={22} className="graph-title">
                {clip(n.title, 26)}
              </text>
              <text x={10} y={42} className="graph-sub">
                {clip(`${n.id} · ${n.status}`, 30)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface PrRef {
  url: string;
  number: number;
  branch: string;
}

interface PrStatusResponse {
  pr?: PrRef;
  eligible: boolean;
  reason?: string;
  suggested?: { branch: string; title: string; body: string; base: string };
}

/** The Create PR/MR flow of an applied run, or the PR it already has. */
export function PrSection({ ws, runId, status }: { ws: string; runId: string; status: string | undefined }) {
  const [info, setInfo] = useState<PrStatusResponse | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}/pr`;
  const mr = ws.startsWith("gitlab~");
  const noun = mr ? "MR" : "PR";

  useEffect(() => {
    if (status === undefined) return;
    let cancelled = false;
    api<PrStatusResponse>(url)
      .then((r) => {
        if (cancelled || typeof r?.eligible !== "boolean") return;
        setInfo(r);
        if (r.suggested) {
          setBranch(r.suggested.branch);
          setBase(r.suggested.base);
          setTitle(r.suggested.title);
          setBody(r.suggested.body);
        }
      })
      .catch(() => {
        if (!cancelled) setInfo(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [url, status]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await post<{ pr: PrRef }>(url, { branch, base, title, body });
      setInfo({ pr: res.pr, eligible: false });
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.error : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  if (info.pr) {
    return (
      <p>
        <a href={info.pr.url} target="_blank" rel="noreferrer" data-testid="pr-link">
          {mr ? "Merge request" : "Pull request"} #{info.pr.number}
        </a>{" "}
        <span className="muted">
          on <code>{info.pr.branch}</code>
        </span>
      </p>
    );
  }
  if (!info.eligible) {
    return (
      <p className="muted" data-testid="pr-reason">
        No {noun}: {info.reason}
      </p>
    );
  }
  return (
    <>
      <button type="button" data-testid="pr-open" onClick={() => setOpen((o) => !o)}>
        Create {noun}
      </button>
      {open && (
        <form className="card start-run pr-form" onSubmit={(e) => void submit(e)} data-testid="pr-form">
          <label>
            Branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} required data-testid="pr-branch" />
          </label>
          <label>
            Base
            <input value={base} onChange={(e) => setBase(e.target.value)} data-testid="pr-base" />
          </label>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="pr-title" />
          </label>
          <label>
            Body
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} data-testid="pr-body" />
          </label>
          {error && (
            <pre className="error start-run-error" data-testid="pr-error">
              {error}
            </pre>
          )}
          <div>
            <button type="submit" disabled={busy} data-testid="pr-submit">
              {busy ? "Submitting…" : "Submit"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

export default function RunDetail() {
  const { ws = "", runId = "" } = useParams();
  const [detail, setDetail] = useState<RunDetailResponse | undefined>(undefined);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setDetail(await api<RunDetailResponse>(`/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}`));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 404 ? "This run does not exist (any more)." : err.error) : String(err));
    }
  }, [ws, runId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const summary = detail?.summary;
  const live = summary?.live === true && summary.viewUrl !== undefined;
  const graph = detail?.graph;
  const tasks = detail?.state?.tasks ?? {};

  return (
    <section data-testid="page-run-detail" className="run-detail">
      <div className="page-head">
        <Link to={ws ? `/runs?workspace=${encodeURIComponent(ws)}` : "/runs"}>← All runs</Link>
      </div>
      <div className="run-head">
        <h1>
          Run <code>{runId}</code>
        </h1>
        {summary && <StatusBadge status={summary.status} />}
        {live && <span className="live-dot" title="Page server is up" aria-label="live" />}
      </div>
      <p className="muted run-meta">
        {workspaceLabel(ws)}
        {summary?.provider && <> · {summary.provider}</>}
        {summary?.type === "suite" && <> · suite</>}
        {summary?.createdAt && <> · created {relativeTime(summary.createdAt)}</>}
      </p>
      {error && <p className="error">{error}</p>}

      <section data-testid="run-pr" className="run-pr">
        {summary?.type === "run" && <PrSection ws={ws} runId={runId} status={summary.status} />}
      </section>

      {live ? (
        <iframe className="run-live" src={summary.viewUrl} title={`Run ${runId}`} data-testid="run-live-view" />
      ) : (
        summary && (
          <div data-testid="run-static-graph" className="run-static">
            {graph && graph.nodes.length > 0 ? <StaticGraph graph={graph} /> : <p className="muted">No task graph for this run.</p>}
            {graph && graph.nodes.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Branch</th>
                  </tr>
                </thead>
                <tbody>
                  {graph.nodes.map((n) => (
                    <tr key={n.id}>
                      <td>
                        <code>{n.id}</code>
                      </td>
                      <td>{n.title}</td>
                      <td>
                        <StatusBadge status={n.status} />
                      </td>
                      <td>{tasks[n.id]?.attempts ?? ""}</td>
                      <td>{tasks[n.id]?.branch ? <code>{tasks[n.id]?.branch}</code> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      )}
    </section>
  );
}
