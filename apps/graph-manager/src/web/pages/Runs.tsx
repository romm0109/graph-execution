import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useKey, useListNav } from "../keys";
import { StaleBanner, UpdatedAgo, useNow, useOverview } from "../overview";
import { post } from "../api";
import { PROJECT_PREFIX, isProjectId, projectOfHome, relativeTime, workspaceLabel } from "../runs";
import type { RunSummary, WorkspaceEntry } from "../types";
import { EmptyState, ForgeChip, Icon, Kbd, LiveDot, Progress, SkeletonRows, StatusBadge as UiStatusBadge, toneOf } from "../ui";
import { useProjects } from "../useProjects";
import { StartRunDrawer } from "./StartRunDrawer";
import "./Runs.css";

export const GROUP_KEY = "gm.runs.group";
export type StatusFilter = "live" | "failed" | "ready";
const STATUS_FILTERS: StatusFilter[] = ["live", "failed", "ready"];

/** A run's status badge (kept for pages that still import it from here). */
export function StatusBadge({ status }: { status: string }) {
  return <UiStatusBadge kind="run" value={status} />;
}

export const isLive = (r: RunSummary): boolean => r.live || r.status === "running";
export const isFailedRun = (r: RunSummary): boolean => r.status === "failed";
/** The workspace has uncommitted changes to put in a PR. Unknown (not listed yet) counts as yes. */
const hasChanges = (ws: WorkspaceEntry | undefined): boolean => ws === undefined || (ws.changes ?? (ws.dirty ? 1 : 0)) > 0;
/**
 * Applied, no PR yet, and (when its workspace is known) there are uncommitted changes to open one from. A project run
 * gets one PR per changed repo from its run page (MR-09).
 */
export const isReady = (r: RunSummary, ws?: WorkspaceEntry): boolean => r.status === "applied" && !r.pr && hasChanges(ws);

/** 0 = failed or live, 1 = ready for PR, 2 = the rest. */
export function attention(r: RunSummary): number {
  if (isFailedRun(r) || isLive(r)) return 0;
  if (isReady(r)) return 1;
  return 2;
}

const createdMs = (r: RunSummary): number => {
  const t = r.createdAt ? Date.parse(r.createdAt) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** Failed and live first, then ready for PR, then the rest; newest first within each. */
export function byAttention(a: RunSummary, b: RunSummary): number {
  return attention(a) - attention(b) || createdMs(b) - createdMs(a) || b.id.localeCompare(a.id);
}

const runPath = (r: RunSummary): string => `/runs/${encodeURIComponent(r.workspaceId)}/${encodeURIComponent(r.id)}`;
/** `github~octo~hello` → `hello`; the project's name for a project run. */
const repoName = (r: RunSummary): string => r.project?.name ?? r.workspaceId.split("~").pop() ?? r.workspaceId;

type RunProject = NonNullable<RunSummary["project"]>;

/** The chip and repo names that mark a project's run or group. */
function ProjectMark({ project, testId }: { project: RunProject; testId?: string }) {
  return (
    <>
      <span className="runs-project-chip" data-testid={testId}>
        project · {project.name}
      </span>
      <span className="runs-project-repos mono muted" title={project.repos.join(", ")}>
        {project.repos.join(", ")}
      </span>
    </>
  );
}
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function readGroup(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveGroup(on: boolean): void {
  try {
    localStorage.setItem(GROUP_KEY, on ? "1" : "0");
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

function matchesStatus(r: RunSummary, f: StatusFilter | undefined, ws?: WorkspaceEntry): boolean {
  if (f === "live") return isLive(r);
  if (f === "failed") return isFailedRun(r);
  if (f === "ready") return isReady(r, ws);
  return true;
}

interface Group {
  id: string;
  ws?: WorkspaceEntry;
  /** Set for the group of a project (`project~<id>`). */
  project?: RunProject;
  runs: RunSummary[];
}

function StatCard({
  label,
  tone,
  glyph,
  value,
  sub,
  active,
  onClick,
  testId,
}: {
  label: string;
  tone: "live" | "bad" | "ok" | "warn";
  glyph: "pulse" | "diamond" | "dot" | "half";
  value: number;
  sub: string;
  active?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  const body = (
    <>
      <span className="runs-card-label">
        <span className={`glyph glyph-${glyph} tone-${tone}`} aria-hidden="true" />
        {label}
      </span>
      <span className={`runs-card-value num${value > 0 && tone !== "live" ? ` tone-text-${tone}` : ""}`}>{value}</span>
      <span className="runs-card-sub">{sub}</span>
    </>
  );
  return (
    <button type="button" className={active ? "runs-card active" : "runs-card"} aria-pressed={active} onClick={onClick} data-testid={testId}>
      {body}
    </button>
  );
}

function ActionCell({ run, ws, onCreatePr }: { run: RunSummary; ws?: WorkspaceEntry; onCreatePr: (r: RunSummary) => void }) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  if (run.pr) {
    const label = run.pr.forge === "gitlab" ? `MR !${run.pr.number} ↗` : `PR #${run.pr.number} ↗`;
    return (
      <a className="runs-pr-link mono" href={run.pr.url} target="_blank" rel="noreferrer" onClick={stop}>
        {label}
      </a>
    );
  }
  if (run.status === "applied" && !run.pr && !hasChanges(ws)) return <span className="runs-failure">no changes to open a PR</span>;
  if (isReady(run, ws)) {
    return (
      <button
        type="button"
        className="btn btn-sm runs-create-pr"
        onClick={(e) => {
          e.stopPropagation();
          onCreatePr(run);
        }}
      >
        {run.project ? "Create PRs" : run.workspaceId.startsWith("gitlab~") ? "Create MR" : "Create PR"}
      </button>
    );
  }
  if ((run.status === "failed" || run.status === "aborted") && run.failure) return <span className="runs-failure">{run.failure}</span>;
  return null;
}

function RunRow({
  run,
  ws,
  focused,
  now,
  onOpen,
  onCreatePr,
}: {
  run: RunSummary;
  ws?: WorkspaceEntry;
  focused: boolean;
  now: number;
  onOpen: (r: RunSummary) => void;
  onCreatePr: (r: RunSummary) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused && typeof ref.current?.scrollIntoView === "function") ref.current.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const counts = run.taskCounts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const merged = counts?.merged ?? 0;
  return (
    <div
      ref={ref}
      role="row"
      className={focused ? "table-row runs-row focused" : "table-row runs-row"}
      onClick={() => onOpen(run)}
      data-testid={`run-row-${run.workspaceId}-${run.id}`}
      data-run={run.id}
    >
      <span role="cell" className="runs-c-status">
        <UiStatusBadge kind="run" value={run.status} />
      </span>
      <span role="cell" className="runs-c-run">
        <Link to={runPath(run)} className="runs-id mono" onClick={(e) => e.stopPropagation()} tabIndex={-1}>
          {run.id}
        </Link>
        {run.live && <LiveDot />}
        {run.project && <ProjectMark project={run.project} testId={`run-project-${run.id}`} />}
      </span>
      <span role="cell" className={run.type === "suite" ? "runs-c-type suite" : "runs-c-type"}>
        {run.type}
      </span>
      <span role="cell" className="runs-c-provider mono">
        {run.provider ?? ""}
      </span>
      <span role="cell" className="runs-c-tasks">
        {counts && (
          <>
            <span className="mono num runs-count">
              {merged}/{total}
            </span>
            <span className="runs-progress">
              <Progress value={total > 0 ? merged / total : 0} tone={toneOf("run", run.status)} label={`${merged} of ${total} tasks merged`} />
            </span>
          </>
        )}
      </span>
      <span role="cell" className="runs-c-created" title={run.createdAt}>
        {relativeTime(run.createdAt, now)}
      </span>
      <span role="cell" className="runs-c-action">
        <ActionCell run={run} ws={ws} onCreatePr={onCreatePr} />
      </span>
    </div>
  );
}

/** The header of a project's runs: the project instead of a forge and branch, and a terminal in the project folder. */
function ProjectGroupHeader({ group }: { group: Group }) {
  const navigate = useNavigate();
  const id = projectOfHome(group.id);
  const project = group.project ?? { id, name: id, repos: [] };
  const [busy, setBusy] = useState(false);
  const openTerminal = async () => {
    setBusy(true);
    try {
      const t = await post<{ id: string }>("/api/terminals", { projectId: id });
      navigate(`/terminals?focus=${encodeURIComponent(t.id)}`);
    } catch {
      navigate("/terminals");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="table-group runs-group" role="row" aria-label={`project ${project.name}`} data-testid={`runs-group-${group.id}`}>
      <ProjectMark project={project} />
      <span className="runs-group-count">{plural(group.runs.length, "run")}</span>
      <span className="runs-group-spacer" />
      <button type="button" className="btn btn-ghost btn-sm runs-open-terminal" onClick={() => void openTerminal()} disabled={busy}>
        <Icon name="terminal" size={14} />
        Open terminal
      </button>
    </div>
  );
}

function GroupHeader({ group }: { group: Group }) {
  if (isProjectId(group.id)) return <ProjectGroupHeader group={group} />;
  const ws = group.ws;
  const forge = (ws?.forge ?? group.id.split("~")[0]) === "gitlab" ? "gitlab" : "github";
  const known = ws?.forge === "github" || ws?.forge === "gitlab" || /^(github|gitlab)~/.test(group.id);
  return (
    <div className="table-group runs-group" role="row" aria-label={workspaceLabel(group.id)} data-testid={`runs-group-${group.id}`}>
      {known && <ForgeChip forge={forge} />}
      <strong className="runs-group-path mono">{ws?.fullPath ?? workspaceLabel(group.id).split("/").slice(1).join("/")}</strong>
      {ws && (
        <span className="runs-group-branch mono">
          <Icon name="branch" size={12} />
          {ws.branch}
        </span>
      )}
      {ws && <span className={ws.dirty ? "runs-pill tone-warn" : "runs-pill tone-ok"}>{ws.dirty ? "dirty" : "clean"}</span>}
      <span className="runs-group-count">{plural(group.runs.length, "run")}</span>
      <span className="runs-group-spacer" />
      <Link className="btn btn-ghost btn-sm runs-open-terminal" to={`/terminals?workspace=${encodeURIComponent(group.id)}`}>
        <Icon name="terminal" size={14} />
        Open terminal
      </Link>
    </div>
  );
}

export default function Runs() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { runs, workspaces, loaded } = useOverview();
  const projects = useProjects();
  const now = useNow(5000);
  const wsFilter = params.get("workspace") ?? "";
  const statusParam = params.get("status");
  const statusFilter = STATUS_FILTERS.includes(statusParam as StatusFilter) ? (statusParam as StatusFilter) : undefined;
  const [text, setText] = useState("");
  const [grouped, setGrouped] = useState(readGroup);
  const [drawer, setDrawer] = useState(params.get("start") === "1");

  const setParam = useCallback(
    (name: string, value: string | undefined) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(name, value);
          else next.delete(name);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // `?start=1` opens the drawer (from the palette or a link); drop it so a reload doesn't reopen it.
  useEffect(() => {
    if (params.get("start") === "1") {
      setDrawer(true);
      setParam("start", undefined);
    }
  }, [params, setParam]);

  const wsById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const workspaceIds = useMemo(() => {
    const ids = new Set(workspaces.map((w) => w.id));
    for (const r of runs) ids.add(r.workspaceId);
    if (wsFilter) ids.add(wsFilter);
    return [...ids].filter((id) => !isProjectId(id)).sort();
  }, [workspaces, runs, wsFilter]);
  // The projects of the filter, after the workspaces: the saved ones plus those seen in runs, by name.
  const projectById = useMemo(() => {
    const byId = new Map<string, RunProject>();
    for (const p of projects) byId.set(`${PROJECT_PREFIX}${p.id}`, { id: p.id, name: p.name, repos: p.workspaces.map((w) => w.repo) });
    for (const r of runs) if (r.project && !byId.has(r.workspaceId)) byId.set(r.workspaceId, r.project);
    if (isProjectId(wsFilter) && !byId.has(wsFilter)) byId.set(wsFilter, { id: projectOfHome(wsFilter), name: projectOfHome(wsFilter), repos: [] });
    return byId;
  }, [projects, runs, wsFilter]);
  const projectIds = useMemo(() => [...projectById.keys()].sort((a, b) => projectById.get(a)!.name.localeCompare(projectById.get(b)!.name)), [projectById]);

  const live = runs.filter(isLive);
  const failed = runs.filter(isFailedRun).sort(byAttention);
  const ready = runs.filter((r) => isReady(r, wsById.get(r.workspaceId)));
  const liveSuites = live.filter((r) => r.type === "suite").length;
  const newestFailed = failed[0];

  const q = text.trim().toLowerCase();
  const shown = useMemo(
    () =>
      runs
        .filter((r) => !wsFilter || r.workspaceId === wsFilter)
        .filter((r) => matchesStatus(r, statusFilter, wsById.get(r.workspaceId)))
        .filter((r) => !q || r.id.toLowerCase().includes(q) || (r.provider ?? "").toLowerCase().includes(q))
        .sort(byAttention),
    [runs, wsFilter, statusFilter, q, wsById],
  );

  const groups = useMemo<Group[]>(() => {
    if (!grouped) return [];
    const map = new Map<string, Group>();
    for (const r of shown) {
      let g = map.get(r.workspaceId);
      if (!g) {
        g = { id: r.workspaceId, ws: wsById.get(r.workspaceId), project: r.project ?? projectById.get(r.workspaceId), runs: [] };
        map.set(r.workspaceId, g);
      }
      g.runs.push(r);
    }
    // Runs are already in attention order, so a group's first run is its most urgent one.
    return [...map.values()].sort((a, b) => byAttention(a.runs[0] as RunSummary, b.runs[0] as RunSummary));
  }, [grouped, shown, wsById, projectById]);

  const visible = useMemo(() => (grouped ? groups.flatMap((g) => g.runs) : shown), [grouped, groups, shown]);

  const open = useCallback((r: RunSummary) => navigate(runPath(r)), [navigate]);
  const createPr = useCallback((r: RunSummary) => navigate(`${runPath(r)}#pr`), [navigate]);
  const [focus] = useListNav(visible.length, { onOpen: (i) => visible[i] && open(visible[i]), enabled: !drawer });
  const focusedRun = focus >= 0 ? visible[focus] : undefined;

  useKey("s", (e) => {
    e.preventDefault();
    setDrawer(true);
  }, { enabled: !drawer });
  useKey("p", () => {
    if (focusedRun && isReady(focusedRun, wsById.get(focusedRun.workspaceId))) createPr(focusedRun);
  }, { enabled: !drawer });

  const toggleStatus = (f: StatusFilter) => setParam("status", statusFilter === f ? undefined : f);
  const toggleGroup = (on: boolean) => {
    setGrouped(on);
    saveGroup(on);
  };

  const rowOf = (r: RunSummary) => {
    const i = visible.indexOf(r);
    return (
      <RunRow key={`${r.workspaceId}/${r.id}`} run={r} ws={wsById.get(r.workspaceId)} focused={i === focus} now={now} onOpen={open} onCreatePr={createPr} />
    );
  };

  const startButton = (
    <button type="button" className="btn btn-primary" onClick={() => setDrawer(true)} data-testid="start-run">
      <Icon name="plus" />
      Start run
      <Kbd>s</Kbd>
    </button>
  );

  return (
    <section className="page runs-page" data-testid="page-runs">
      <header className="page-header runs-header">
        <h1>Runs</h1>
        <UpdatedAgo />
        <span className="runs-header-spacer" />
        {startButton}
      </header>
      <StaleBanner />

      {!loaded ? (
        <SkeletonRows rows={5} />
      ) : runs.length === 0 ? (
        <div className="runs-empty card">
          <EmptyState
            title="No runs yet"
            body="Runs started from a terminal show up here on their own. You can also start one here."
            action={
              <>
                <code className="runs-empty-cmd mono">graph-execution .agents/tasks --spec docs/prd.md --web</code>
                <button type="button" className="btn btn-primary" onClick={() => setDrawer(true)}>
                  Start run
                </button>
              </>
            }
          />
        </div>
      ) : (
        <>
          <div className="runs-cards">
            <StatCard
              label="Live"
              tone="live"
              glyph="pulse"
              value={live.length}
              sub={`${plural(live.length - liveSuites, "run")} · ${plural(liveSuites, "suite")}`}
              active={statusFilter === "live"}
              onClick={() => toggleStatus("live")}
              testId="card-live"
            />
            <StatCard
              label="Failed"
              tone="bad"
              glyph="diamond"
              value={failed.length}
              sub={newestFailed ? `${repoName(newestFailed)} · ${relativeTime(newestFailed.createdAt, now)}` : "nothing failed"}
              active={statusFilter === "failed"}
              onClick={() => toggleStatus("failed")}
              testId="card-failed"
            />
            <StatCard
              label="Ready for PR"
              tone="ok"
              glyph="dot"
              value={ready.length}
              sub="applied, no PR yet"
              active={statusFilter === "ready"}
              onClick={() => toggleStatus("ready")}
              testId="card-ready"
            />
          </div>

          <div className="runs-filters">
            <label className="runs-ws-select">
              Workspace
              <select value={wsFilter} onChange={(e) => setParam("workspace", e.target.value || undefined)} data-testid="runs-filter">
                <option value="">All workspaces</option>
                {workspaceIds.map((id) => (
                  <option key={id} value={id}>
                    {wsById.get(id)?.fullPath ?? workspaceLabel(id)}
                  </option>
                ))}
                {projectIds.length > 0 && (
                  <optgroup label="Projects">
                    {projectIds.map((id) => (
                      <option key={id} value={id}>
                        {projectById.get(id)?.name ?? projectOfHome(id)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="runs-search">
              <Icon name="search" size={14} />
              <input
                type="search"
                aria-label="Filter runs"
                placeholder="Filter by run id, provider…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && text) {
                    e.stopPropagation();
                    setText("");
                  }
                }}
                data-filter
                data-testid="runs-text-filter"
              />
              <Kbd>/</Kbd>
            </label>
            <span className="runs-header-spacer" />
            <label className="runs-group-toggle">
              <input type="checkbox" checked={grouped} onChange={(e) => toggleGroup(e.target.checked)} data-testid="runs-group-toggle" />
              Group by workspace
            </label>
          </div>

          <div className="runs-table-wrap">
            <div className="runs-table" role="table" aria-label="Runs" data-testid="runs-table">
              <div className="runs-head" role="row">
                <span role="columnheader">Status</span>
                <span role="columnheader">Run</span>
                <span role="columnheader">Type</span>
                <span role="columnheader">Provider</span>
                <span role="columnheader">Tasks merged</span>
                <span role="columnheader">Created ↓</span>
                <span role="columnheader" className="runs-c-action">
                  Action
                </span>
              </div>
              {visible.length === 0 && <div className="runs-none muted">No runs match these filters.</div>}
              {grouped
                ? groups.map((g) => (
                    <div key={g.id} role="rowgroup" className="runs-rowgroup">
                      <GroupHeader group={g} />
                      {g.runs.map(rowOf)}
                    </div>
                  ))
                : visible.map(rowOf)}
            </div>
          </div>

          <p className="runs-note">
            Sorted by attention: failed and live first, then ready for PR, then the rest by created time. <Kbd>j</Kbd>/<Kbd>k</Kbd> to move,{" "}
            <Kbd>Enter</Kbd> to open, <Kbd>p</Kbd> to create a PR on the focused row.
          </p>
        </>
      )}

      <StartRunDrawer open={drawer} onClose={() => setDrawer(false)} workspaces={workspaces} initialWorkspace={wsFilter || undefined} />
    </section>
  );
}
