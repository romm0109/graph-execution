import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useListNav } from "../keys";
import { useOverview } from "../overview";
import type { RunSummary, WorkspaceEntry } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { ForgeChip } from "../ui/ForgeChip";
import { Icon } from "../ui/Icon";
import { SkeletonRows } from "../ui/Skeleton";
import { useToast } from "../ui/toast";
import { CloneDrawer } from "./CloneDrawer";
import { WorkspaceSettingsDrawer } from "./WorkspaceSettingsDrawer";
import "./Workspaces.css";

export type { WorkspaceEntry } from "../types";

export const LIVE_DELETE_HINT = "A run is live in this workspace. Abort it or wait for it to finish.";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const terminalUrl = (id: string) => `/terminals?workspace=${encodeURIComponent(id)}`;

function TrashIcon() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.6c.05.5.47.9.98.9h4.64c.51 0 .93-.4.98-.9l.7-8.6" />
    </svg>
  );
}

/** "This removes the clone and its 3 uncommitted files from the container. …" */
export function deleteBody(ws: WorkspaceEntry): string {
  const n = ws.changes ?? (ws.dirty ? 1 : 0);
  const what = n > 0 ? `the clone and its ${n} uncommitted ${n === 1 ? "file" : "files"}` : "the clone";
  return `This removes ${what} from the container. Its runs are removed with it.`;
}

interface RunStats {
  total: number;
  live: RunSummary[];
}

type Dialog = { kind: "confirm"; ws: WorkspaceEntry } | { kind: "blocked"; ws: WorkspaceEntry; runId?: string };

function RunsCell({ stats }: { stats?: RunStats }) {
  if (!stats || stats.total === 0) return <span className="muted">—</span>;
  if (stats.live.length === 0) return <span className="num">{stats.total}</span>;
  return (
    <>
      <span className="glyph glyph-pulse tone-live" aria-hidden="true" />
      <span className="num">
        {stats.total} · {stats.live.length} live
      </span>
    </>
  );
}

export default function Workspaces() {
  const navigate = useNavigate();
  const toast = useToast();
  const { runs, workspaces, workspacesRoot, forges, loaded, refresh } = useOverview();
  const [params, setParams] = useSearchParams();
  const cloneOpen = params.get("clone") === "1";
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [settingsFor, setSettingsFor] = useState<WorkspaceEntry | undefined>();

  const setCloneOpen = (open: boolean) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (open) next.set("clone", "1");
        else next.delete("clone");
        return next;
      },
      { replace: true },
    );

  const stats = useMemo(() => {
    const m = new Map<string, RunStats>();
    for (const r of runs) {
      const s = m.get(r.workspaceId) ?? { total: 0, live: [] };
      s.total += 1;
      if (r.live || r.kind === "live") s.live.push(r); // kind "live": the run lock is held, even with no page (the server guards on it)
      m.set(r.workspaceId, s);
    }
    return m;
  }, [runs]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => [w.fullPath, w.branch, w.remoteUrl].some((x) => x.toLowerCase().includes(q)));
  }, [workspaces, filter]);

  const [focused, setFocused] = useListNav(shown.length, {
    onOpen: (i) => {
      const ws = shown[i];
      if (ws) void navigate(terminalUrl(ws.id));
    },
    enabled: !cloneOpen && dialog === undefined,
  });

  const anyForge = forges.github.connected || forges.gitlab.connected;
  const login = forges.github.connected ? forges.github.login : forges.gitlab.login;

  const askDelete = (ws: WorkspaceEntry) => {
    const live = stats.get(ws.id)?.live[0];
    setDialog(live ? { kind: "blocked", ws, runId: live.id } : { kind: "confirm", ws });
  };

  const remove = async (ws: WorkspaceEntry) => {
    setBusy(true);
    try {
      await api(`/api/workspaces/${encodeURIComponent(ws.id)}`, {
        method: "DELETE",
      });
      setDialog(undefined);
      await refresh();
      toast.show({ tone: "ok", text: `Deleted ${ws.fullPath}` });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDialog({
          kind: "blocked",
          ws,
          runId: stats.get(ws.id)?.live[0]?.id,
        });
      } else {
        setDialog(undefined);
        toast.show({
          tone: "bad",
          text: `Couldn’t delete ${ws.fullPath}: ${message(err)}`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!loaded) {
    body = <SkeletonRows rows={4} />;
  } else if (workspaces.length === 0) {
    body = anyForge ? (
      <EmptyState
        icon={<Icon name="folder" size={22} />}
        title="No workspaces yet"
        body={
          <>
            Connected as <span className="mono">{login ?? "?"}</span>. Clone a repository to start.
          </>
        }
        action={
          <button type="button" className="btn btn-primary" onClick={() => setCloneOpen(true)}>
            Clone repository
          </button>
        }
      />
    ) : (
      <EmptyState
        icon={<Icon name="git" size={22} />}
        title="Connect GitHub or GitLab first"
        body="A personal access token lets graph-manager search and clone your repositories."
        action={
          <Link className="btn btn-primary" to="/settings">
            Go to Settings
          </Link>
        }
      />
    );
  } else {
    body = (
      <>
        <div className="ws-table-wrap">
          <div className="ws-table" role="table" aria-label="Workspaces">
            <div className="ws-row ws-head" role="row">
              <span role="columnheader">Forge</span>
              <span role="columnheader">Repository</span>
              <span role="columnheader">Branch</span>
              <span role="columnheader">Tree</span>
              <span role="columnheader">Runs</span>
              <span role="columnheader" className="ws-actions-head">
                Actions
              </span>
            </div>
            {shown.length === 0 && (
              <div className="ws-row ws-nomatch muted" role="row">
                <span role="cell">No workspaces match “{filter.trim()}”.</span>
              </div>
            )}
            {shown.map((ws, i) => {
              const s = stats.get(ws.id);
              const live = (s?.live.length ?? 0) > 0;
              return (
                <div
                  key={ws.id}
                  role="row"
                  className={i === focused ? "ws-row table-row focused" : "ws-row table-row"}
                  data-testid={`workspace-${ws.id}`}
                  onMouseDown={() => setFocused(i)}
                >
                  <span role="cell" className="ws-forge">
                    {ws.forge === "github" || ws.forge === "gitlab" ? <ForgeChip forge={ws.forge} /> : <span className="chip">{ws.forge}</span>}
                  </span>
                  <span role="cell" className="ws-repo">
                    <strong className="mono ws-name" title={ws.fullPath}>
                      {ws.fullPath}
                    </strong>
                    <span className="mono ws-remote" title={ws.remoteUrl}>
                      {ws.remoteUrl}
                    </span>
                  </span>
                  <span role="cell" className="mono ws-branch" title={ws.branch}>
                    {ws.branch || "—"}
                  </span>
                  <span role="cell" className="ws-tree" data-testid={`state-${ws.id}`}>
                    <span className={ws.dirty ? "badge tone-warn" : "badge tone-ok"}>{ws.dirty ? "dirty" : "clean"}</span>
                  </span>
                  <span role="cell" className="ws-runs" data-testid={`runs-count-${ws.id}`}>
                    <RunsCell stats={s} />
                  </span>
                  <span role="cell" className="ws-actions">
                    <Link className="btn btn-sm" to={terminalUrl(ws.id)} data-testid={`open-terminal-${ws.id}`}>
                      <Icon name="terminal" size={14} />
                      Open terminal
                    </Link>
                    <Link className="btn btn-sm" to={`/runs?workspace=${encodeURIComponent(ws.id)}`} data-testid={`runs-${ws.id}`}>
                      Runs
                    </Link>
                    <button type="button" className="btn btn-sm" data-testid={`settings-${ws.id}`} onClick={() => setSettingsFor(ws)}>
                      Settings
                    </button>
                    <span
                      className="ws-delete-wrap"
                      title={live ? LIVE_DELETE_HINT : undefined}
                      data-testid={`delete-wrap-${ws.id}`}
                      onClick={() => {
                        if (live) askDelete(ws);
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost btn-icon ws-delete"
                        aria-label={`Delete ${ws.fullPath}`}
                        title={live ? LIVE_DELETE_HINT : "Delete workspace"}
                        disabled={live}
                        data-testid={`delete-${ws.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          askDelete(ws);
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <p className="ws-note">Delete is disabled while a run is live in that workspace. Hover the button to see why.</p>
      </>
    );
  }

  const blocked = dialog?.kind === "blocked" ? dialog : undefined;
  const confirm = dialog?.kind === "confirm" ? dialog : undefined;

  return (
    <section data-testid="page-workspaces" className="page workspaces-page">
      <header className="page-header ws-header">
        <h1>
          Workspaces{" "}
          <span className="mono ws-count" data-testid="workspace-count">
            {workspaces.length}
          </span>
        </h1>
        {workspacesRoot && (
          <span className="mono ws-root" data-testid="workspaces-root">
            {workspacesRoot}
          </span>
        )}
        <span className="ws-spacer" />
        <label className="ws-filter">
          <Icon name="search" size={14} />
          <input type="search" aria-label="Filter workspaces" placeholder="Filter" data-filter value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" data-testid="clone-open" onClick={() => setCloneOpen(true)}>
          <Icon name="plus" size={14} />
          Clone repository
        </button>
      </header>

      {body}

      <CloneDrawer open={cloneOpen} onClose={() => setCloneOpen(false)} forges={forges} workspaces={workspaces} root={workspacesRoot} refresh={refresh} />
      <WorkspaceSettingsDrawer workspace={settingsFor} onClose={() => setSettingsFor(undefined)} />

      <ConfirmDialog
        open={confirm !== undefined}
        tone="danger"
        title={confirm ? `Delete workspace ${confirm.ws.fullPath}?` : ""}
        body={confirm ? deleteBody(confirm.ws) : ""}
        confirmLabel="Delete"
        busy={busy}
        onConfirm={() => {
          if (confirm) void remove(confirm.ws);
        }}
        onCancel={() => setDialog(undefined)}
      />
      <ConfirmDialog
        open={blocked !== undefined}
        title={blocked ? `Can’t delete ${blocked.ws.fullPath} yet` : ""}
        body={blocked?.runId ? `Run ${blocked.runId} is live in this workspace. Abort it or wait for it to finish.` : LIVE_DELETE_HINT}
        // Board 19: "OK" closes, "Open run" (primary) goes to the live run.
        cancelLabel={blocked?.runId ? "OK" : "Cancel"}
        confirmLabel={blocked?.runId ? "Open run" : "OK"}
        onConfirm={() => {
          const b = blocked;
          setDialog(undefined);
          if (b?.runId) void navigate(`/runs/${encodeURIComponent(b.ws.id)}/${encodeURIComponent(b.runId)}`);
        }}
        onCancel={() => setDialog(undefined)}
      />
    </section>
  );
}
